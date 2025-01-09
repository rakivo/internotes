use std::net::{IpAddr, UdpSocket};

use r2d2::Pool;
use uuid::Uuid;
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
    Responder, middleware::Logger, web::{self, Path, Data, Json}
};

mod qr;
use qr::*;

#[allow(unused_imports, unused_parens, non_camel_case_types, unused_mut, dead_code, unused_assignments, unused_variables, static_mut_refs, non_snake_case, non_upper_case_globals)]
mod stb_image_write;

const PORT: u16 = 6969;

type UnixTimeStamp = i64;
type DbPool = Pool::<SqliteConnectionManager>;

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
    title: String,
    status: Status,
    mod_time: UnixTimeStamp,
    description: String,
}

struct Server {
    qr_bytes: web::Bytes,
    db_pool: Data::<DbPool>
}

impl Server {
    #[inline]
    fn insert_note(&self, note: &Note) -> Result::<usize, rusqlite::Error> {
        let conn = self.db_pool.get().unwrap();
        conn.execute(
            "INSERT INTO notes (uuid, title, description, status, mod_time) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                note.uuid.to_string(),
                note.title,
                note.description,
                note.status.to_string(),
                note.mod_time
            ]
        )
    }

    fn get_notes(&self) -> Result::<Vec::<Note>> {
        let conn = self.db_pool.get().unwrap();
        let mut stmt = conn.prepare("SELECT uuid, title, description, status, mod_time FROM notes")?;
        let notes = stmt.query_map([], |row| {
            Ok(Note {
                uuid: Uuid::parse_str(&row.get::<_, String>(0)?).expect("invalid UUID"),
                title: row.get(1)?,
                description: row.get(2)?,
                status: Status::from_str(&row.get::<_, String>(3)?).unwrap(),
                mod_time: row.get(4)?
            })
        })?.collect::<Result::<_, _>>()?;
        Ok(notes)
    }
}

#[inline]
fn get_default_local_ip_addr() -> Option::<IpAddr> {
    let sock = UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("1.1.1.1:80").ok()?;
    sock.local_addr().ok().map(|addr| addr.ip())
}

#[get("/qr.png")]
async fn qr_code(state: Data::<Server>) -> impl Responder {
    HttpResponse::Ok()
        .content_type("image/png")
        .body(web::Bytes::clone(&state.qr_bytes))
}

#[put("/new-note")]
async fn new_note(state: Data::<Server>, note: Json::<Note>) -> impl Responder {
    let mut note = note.into_inner();
    note.uuid = Uuid::new_v4();
    if let Err(e) = state.insert_note(&note) {
        let e = format!("could not insert note: {e}");
        eprintln!("{e}");
        HttpResponse::InternalServerError().body(e)
    } else {
        HttpResponse::Ok().json(json!({"uuid": note.uuid}))
    }
}

#[get("/notes")]
async fn get_notes(state: Data::<Server>) -> impl Responder {
    match state.get_notes() {
        Ok(notes) => HttpResponse::Ok().body(serde_json::to_string(&notes).unwrap()),
        Err(e) => {
            let e = format!("could not get notes: {e}");
            eprintln!("{e}");
            HttpResponse::InternalServerError().body(e)
        }
    }
}

#[delete("/remove-note/{uuid}")]
async fn remove_note(state: Data::<Server>, uuid: Path::<String>) -> impl Responder {
    let uuid = uuid.into_inner();
    let conn = state.db_pool.get().unwrap();
    let ret = conn.execute(
        "DELETE FROM notes WHERE uuid = ?1", 
        params![uuid]
    );

    match ret {
        Ok(rows_affected) if rows_affected > 0 => {
            HttpResponse::Ok().json(json!({"status": "note removed successfully"}))
        },
        Ok(_) => HttpResponse::NotFound().json(json!({"status": "note not found"})),
        Err(e) => {
            let e = format!("could not delete note: {e}");
            eprintln!("{e}");
            HttpResponse::InternalServerError().body(e)
        }
    }
}

#[actix_web::main]
async fn main() -> std::io::Result::<()> {
    env_logger::init_from_env(env_logger::Env::new().default_filter_or("info"));

    let local_ip = get_default_local_ip_addr().unwrap_or_else(|| panic!("could not find local IP address"));
    let server = Data::new(Server {
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
    });

    println!("[INFO] serving at: <http://{local_ip}:{PORT}>");

    HttpServer::new(move || {
        App::new()
            .wrap(Logger::default())
            .app_data(Data::clone(&server))

            .service(qr_code)
            .service(new_note)
            .service(get_notes)
            .service(remove_note)
            .service(Files::new("/", "static").index_file("index.html"))
    }).bind((local_ip, PORT))?.run().await
}
