use std::str::FromStr;
use std::thread::spawn;
use std::net::{IpAddr, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};

use r2d2::Pool;
use uuid::Uuid;
use actix_files::Files;
use qrcodegen::{QrCode, QrCodeEcc};
use serde::{Serialize, Deserialize};
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::{params, Connection, Result};
use actix_web::{
    get, post,
    App, HttpServer, HttpRequest, HttpResponse,
    Responder, middleware::Logger, web::{self, Path, Data}
};

mod qr;
use qr::*;

#[allow(unused_imports, unused_parens, non_camel_case_types, unused_mut, dead_code, unused_assignments, unused_variables, static_mut_refs, non_snake_case, non_upper_case_globals)]
mod stb_image_write;

const PORT: u16 = 6969;

type UnixTimeStamp = i64;
type DbPool = Pool::<SqliteConnectionManager>;

#[derive(Debug, Serialize, Deserialize)]
enum Status {
    Done,
    Active,
    Canceled,
}

impl Status {
    fn to_str(&self) -> &'static str {
        match self {
            Self::Done => "done",
            Self::Active => "active",
            Self::Canceled => "canceled"
        }
    }
}

impl FromStr for Status {
    type Err = ();

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "done" => Ok(Self::Done),
            "active" => Ok(Self::Active),
            "canceled" => Ok(Self::Canceled),
            _ => Err(())
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct Note {
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
                note.status.to_str(),
                note.mod_time,
            ],
        )
    }

    fn get_notes(&self) -> Result::<Vec::<Note>> {
        let conn = self.db_pool.get().unwrap();
        let mut stmt = conn.prepare("SELECT uuid, title, description, status, mod_time FROM notes")?;
        let notes = stmt.query_map([], |row| {
            Ok(Note {
                uuid: Uuid::parse_str(&row.get::<_, String>(0)?).expect("Invalid UUID"),
                title: row.get(1)?,
                description: row.get(2)?,
                status: Status::from_str(&row.get::<_, String>(3)?).unwrap(),
                mod_time: row.get(4)?,
            })
        })?.collect::<Result<Vec<Note>, _>>()?;
        Ok(notes)
    }
}

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

#[actix_web::main]
async fn main() -> std::io::Result::<()> {
    // let local_ip = get_default_local_ip_addr().unwrap_or_else(|| panic!("could not find local IP address"));
    // let server = Data::new(Server {
    //     qr_bytes: {
    //         let local_addr = format!("http://{local_ip}:{PORT}");
    //         let qr = QrCode::encode_text(&local_addr, QrCodeEcc::Low).expect("could not encode URL to QR code");
    //         gen_qr_png_bytes(&qr).expect("could not generate QR code image").into()
    //     },

    //     db_pool: {
    //         let manager = SqliteConnectionManager::file("internotes.db");
    //         Data::new(Pool::new(manager).unwrap())
    //     }
    // });

    // let conn = server.db_pool.get().unwrap();

    // conn.execute(
    //     "CREATE TABLE IF NOT EXISTS notes (
    //         uuid        TEXT PRIMARY KEY,
    //         title       TEXT NOT NULL,
    //         status      TEXT NOT NULL,
    //         mod_time    INTEGER NOT NULL,
    //         description TEXT NOT NULL
    //     )",
    //     ()
    // ).unwrap();

    // server.insert_note(&Note {
    //     uuid: Uuid::new_v4(),
    //     title: "burson".to_owned(),
    //     status: Status::Active,
    //     mod_time: 69,
    //     description: "desc".to_owned()
    // }).unwrap();

    // HttpServer::new(move || {
    //     App::new()
    //         .service(Files::new("/", "static").index_file("index.html"))
    // }).bind((local_ip, PORT))?.run().await

    Ok(())
}
