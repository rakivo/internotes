use std::sync::{Arc, Mutex};
use std::net::{IpAddr, UdpSocket};

use r2d2::Pool;
use uuid::Uuid;
use dashmap::DashMap;
use serde_json::json;
use actix_files::Files;
use rusqlite::{params, Result};
use qrcodegen::{QrCode, QrCodeEcc};
use derive_more::{Display, FromStr};
use serde::{Serialize, Deserialize};
use r2d2_sqlite::SqliteConnectionManager;
use actix_web::{
    get, put, delete,
    App, HttpServer, HttpResponse,
    Responder, middleware::Logger, web::{self, Data, Json}
};

mod qr;
use qr::*;

#[allow(unused_imports, unused_parens, non_camel_case_types, unused_mut, dead_code, unused_assignments, unused_variables, static_mut_refs, non_snake_case, non_upper_case_globals)]
mod stb_image_write;

const PORT: u16 = 6969;

type UnixTimeStamp = i64;
type Notes = DashMap::<Uuid, Arc::<Note>>;
type DbPool = Pool::<SqliteConnectionManager>;

mod json {
    use super::Deserialize;

    #[derive(Deserialize)]
    pub struct Uuid { pub uuid: super::Uuid }
}

#[repr(u8)]
#[derive(Debug, FromStr, Display, Serialize, Deserialize)]
enum Status {
    Done,
    Active,
    Canceled,
}

#[derive(Debug, Serialize, Deserialize)]
struct Note {
    #[serde(skip_deserializing)]
    uuid: Uuid,
    #[serde(skip)]
    from_db: bool,
    title: Box::<str>,
    status: Status,
    mod_time: UnixTimeStamp,
    description: Box::<str>,
}


struct Server {
    notes: Notes,
    removed_notes: Mutex::<Vec::<Arc::<Note>>>,

    qr_bytes: web::Bytes,
    db_pool: Data::<DbPool>,
}

impl Server {
    #[inline]
    fn insert_note(&self, note: Note) {
        _ = self.notes.insert(note.uuid, Arc::new(note))
    }

    fn get_notes(&self) -> Result::<Notes> {
        let conn = self.db_pool.get().unwrap();
        let mut stmt = conn.prepare("SELECT uuid, title, description, status, mod_time FROM notes")?;
        let notes = stmt.query_map([], |row| {
            let uuid = Uuid::parse_str(&row.get::<_, String>(0)?).expect("invalid UUID");
            Ok((Uuid::clone(&uuid), Arc::new(Note {
                uuid,
                from_db: true,
                title: row.get(1)?,
                description: row.get(2)?,
                status: Status::from_str(&row.get::<_, String>(3)?).unwrap(),
                mod_time: row.get(4)?
            })))
        })?.collect::<Result::<_, _>>()?;
        Ok(notes)
    }
}

#[inline]
#[get("/qr.png")]
async fn qr_code(state: Data::<Server>) -> impl Responder {
    HttpResponse::Ok().content_type("image/png").body(web::Bytes::clone(&state.qr_bytes))
}

#[put("/new-note")]
async fn new_note(state: Data::<Server>, note: Json::<Note>) -> impl Responder {
    let uuid = Uuid::new_v4();

    {
        let mut note = note.into_inner();
        note.from_db = false;
        note.uuid = uuid;
        state.insert_note(note);
    }

    HttpResponse::Ok().json(json!({"uuid": uuid}))
}

#[inline]
#[get("/notes")]
async fn get_notes(state: Data::<Server>) -> impl Responder {
    let notes = state.notes.iter().map(|e| Arc::clone(&e.value())).collect::<Vec::<_>>();
    HttpResponse::Ok().body(serde_json::to_string(&notes).unwrap())
}

#[inline]
fn get_default_local_ip_addr() -> Option::<IpAddr> {
    let sock = UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("1.1.1.1:80").ok()?;
    sock.local_addr().ok().map(|addr| addr.ip())
}

#[delete("/remove-note")]
async fn remove_note(state: Data::<Server>, json: Json::<json::Uuid>) -> impl Responder {
    let uuid = json.into_inner().uuid;
    if let Some((.., note)) = state.notes.remove(&uuid) {
        state.removed_notes.lock().unwrap().push(note);
        HttpResponse::Ok().json(json!({"status": "note removed successfully"}))
    } else {
        HttpResponse::NotFound().json(json!({"status": "note not found"}))
    }
}

#[actix_web::main]
async fn main() -> std::io::Result::<()> {
    env_logger::init_from_env(env_logger::Env::new().default_filter_or("info"));

    let local_ip = get_default_local_ip_addr().unwrap_or_else(|| panic!("could not find local IP address"));
    let mut server = Server {
        notes: Notes::new(),
        removed_notes: Mutex::new(Vec::new()),

        qr_bytes: {
            let local_addr = format!("http://{local_ip}:{PORT}");
            let qr = QrCode::encode_text(&local_addr, QrCodeEcc::Low).expect("could not encode URL to QR code");
            gen_qr_png_bytes(&qr).expect("could not generate QR code image").into()
        },

        db_pool: {
            let manager = SqliteConnectionManager::file("internotes.db");
            let pool = Pool::new(manager).expect("could not initialize db pool");
            let conn = pool.get().unwrap();
            conn.execute(
                "CREATE TABLE IF NOT EXISTS notes (
                    uuid        TEXT PRIMARY KEY,
                    title       TEXT NOT NULL,
                    status      TEXT NOT NULL,
                    mod_time    INTEGER NOT NULL,
                    description TEXT NOT NULL
                )",
                ()
            ).expect("could not initialize notes table");
            Data::new(pool)
        }
    };

    server.notes = server.get_notes().unwrap();

    let server = Data::new(server);
    let serverc = Data::clone(&server);

    println!("[INFO] serving at: <http://{local_ip}:{PORT}>");

    HttpServer::new(move || {
        App::new()
            .wrap(Logger::default())
            .app_data(Data::clone(&serverc))

            .service(qr_code)
            .service(new_note)
            .service(get_notes)
            .service(remove_note)
            .service(Files::new("/", "static").index_file("index.html"))
    }).bind((local_ip, PORT))?.run().await?;

    let conn = server.db_pool.get().unwrap();

    server.notes.iter().filter(|e| !e.from_db).for_each(|e| {
        if let Err(e) = conn.execute(
            "INSERT INTO notes (uuid, title, description, status, mod_time) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![e.uuid.to_string(), e.title, e.description, e.status.to_string(), e.mod_time]
        ) {
            eprintln!("could not insert note into table: {e}")
        }
    });

    server.removed_notes.lock().unwrap().iter().map(|e| e.uuid.to_string()).for_each(|uuid| {
        if let Err(e) = conn.execute("DELETE FROM notes WHERE uuid = ?1", params![uuid]) {
            eprintln!("could not delete note from table: {e}")
        }
    });

    Ok(())
}
