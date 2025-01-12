use std::time::Duration;
use std::sync::{Arc, Mutex};
use std::net::{IpAddr, UdpSocket};
use std::time::{SystemTime, UNIX_EPOCH};
use std::sync::atomic::{Ordering, AtomicBool, AtomicUsize};

use uuid::Uuid;
use dashmap::DashMap;
use serde_json::json;
use actix_rt::signal;
use actix_files::Files;
use actix_rt::task::JoinHandle;
use qrcodegen::{QrCode, QrCodeEcc};
use derive_more::{Display, FromStr};
use serde::{Serialize, Deserialize};
use rusqlite::{params, Result, Connection};
use actix_web::{
    get, put, post, delete, rt as actix_rt,
    App, HttpServer, HttpResponse, Responder,
    middleware::Logger, web::{self, Data, Json}
};

mod qr;
use qr::*;

#[allow(unused_imports, unused_parens, non_camel_case_types, unused_mut, dead_code, unused_assignments, unused_variables, static_mut_refs, non_snake_case, non_upper_case_globals)]
mod stb_image_write;

const PORT: u16 = 6969;

macro_rules! atomic_type {
    ($(type $name: ident = $ty: ty;)*) => {$(paste::paste! {
        #[allow(unused)] type $name = $ty;
        #[allow(unused)] type [<Atomic $name>] = Arc::<$ty>;
    })*};
}

type UnixTimeStamp = i64;

atomic_type! {
    type Notes = DashMap::<Uuid, Arc::<Note>>;
    type RemovedNotes = Mutex::<Vec::<Arc::<Note>>>;
}

mod json {
    use super::Deserialize;

    #[derive(Deserialize)]
    pub struct Uuid { pub uuid: super::Uuid }

    #[derive(Deserialize)]
    pub struct Note {
        pub uuid: super::Uuid,
        pub title: Box::<str>,
        pub status: super::Status,
        pub mod_time: super::UnixTimeStamp,
        pub description: Box::<str>
    }
}

#[repr(u8)]
#[derive(Clone, Debug, FromStr, Display, Serialize, Deserialize)]
enum Status {
    Active,
    Archived,
    Completed,
}

#[repr(u8)]
#[derive(Clone, Debug, Default, PartialEq)]
enum NoteDbStatus {
    #[default]
    New,
    FromDb,
    Updated,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Note {
    uuid: Uuid,
    #[serde(skip)]
    db_status: NoteDbStatus,
    title: Box::<str>,
    status: Status,
    mod_time: UnixTimeStamp,
    description: Box::<str>,
}

#[repr(transparent)]
struct Db(Connection);

mod db {
    use std::time::Duration;

    pub type Result = rusqlite::Result::<usize>;

    pub const FILE_PATH: &str = "internotes.db";
    pub const DB_INSERTION_NOTES_COUNT_THRESHOLD: usize = 5;
    pub const DB_INSERTION_DURATION_THRESHOLD: Duration = Duration::from_secs(15);
}

impl Db {
    #[inline]
    fn new() -> Self {
        use db::FILE_PATH;
        let conn = match Connection::open(FILE_PATH) {
            Ok(ok) => ok,
            Err(e) => panic!("could not open database file: {FILE_PATH}: {e}")
        };
        Db(conn)
    }

    fn get_notes(&self) -> Result::<Notes> {
        let ref conn = self.0;
        let mut stmt = conn.prepare("SELECT uuid, title, description, status, mod_time FROM notes")?;
        let notes = stmt.query_map([], |row| {
            let uuid = Uuid::parse_str(&row.get::<_, String>(0)?).expect("invalid UUID");
            Ok((Uuid::clone(&uuid), Arc::new(Note {
                uuid,
                db_status: NoteDbStatus::FromDb,
                title: row.get(1)?,
                description: row.get(2)?,
                status: Status::from_str(&row.get::<_, String>(3)?).unwrap(),
                mod_time: row.get(4)?
            })))
        })?.collect::<Result::<_, _>>()?;
        Ok(notes)
    }

    #[inline]
    fn insert_notes(&self, notes: &Notes) -> Vec::<db::Result> {
        let ref conn = self.0;
        notes.iter().filter(|e| e.db_status == NoteDbStatus::New).map(|e| {
            conn.execute(
                "INSERT INTO notes (uuid, title, description, status, mod_time) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![e.uuid.to_string(), e.title, e.description, e.status.to_string(), e.mod_time]
            )
        }).collect()
    }

    fn update_notes(&self, notes: &Notes) -> Vec::<db::Result> {
        let ref conn = self.0;
        notes.iter().filter(|e| e.db_status == NoteDbStatus::Updated).filter(|e| {
            match conn.query_row(
                "SELECT 1 FROM notes WHERE uuid = ?1 LIMIT 1",
                params![e.uuid.to_string()],
                |_| Ok(())
            ) {
                Ok(_) => true,
                Err(rusqlite::Error::QueryReturnedNoRows) => false,
                Err(err) => {
                    eprintln!("could not update note with uuid: {uuid}: {err}", uuid = e.uuid);
                    false
                }
            }
        }).map(|e| {
            conn.execute(
                "UPDATE notes SET title = ?1, description = ?2, status = ?3, mod_time = ?4 WHERE uuid = ?5",
                params![e.title, e.description, e.status.to_string(), e.mod_time, e.uuid.to_string()],
            )
        }).collect()
    }

    #[inline]
    fn remove_notes(&self, removed_notes: &AtomicRemovedNotes) -> Vec::<db::Result> {
        let ref conn = self.0;
        removed_notes.lock().unwrap().iter().map(|e| e.uuid.to_string()).map(|uuid| {
            conn.execute("DELETE FROM notes WHERE uuid = ?1", params![uuid])
        }).collect()
    }

    fn update(&self, notes: &Notes, removed_notes: &AtomicRemovedNotes) {
        self.insert_notes(notes).iter().for_each(|res| {
            if let Err(e) = res {
                eprintln!("could not insert new note into table: {e}")
            }
        });

        self.update_notes(notes).iter().for_each(|res| {
            if let Err(e) = res {
                eprintln!("could not update note: {e}")
            }
        });

        self.remove_notes(removed_notes).iter().for_each(|res| {
            if let Err(e) = res {
                eprintln!("could not remove note: {e}")
            }
        });
    }
}

struct DbThread {
    db: Db,
    notes: AtomicNotes,
    stop: Arc::<AtomicBool>,
    removed_notes: AtomicRemovedNotes,
    last_update_time: Option::<Duration>,
    changed_notes_count: Arc::<AtomicUsize>
}

impl DbThread {
    #[inline]
    fn new(
        db: Db,
        stop: Arc::<AtomicBool>,
        notes: AtomicNotes,
        removed_notes: AtomicRemovedNotes,
        changed_notes_count: Arc::<AtomicUsize>
    ) -> Self {
        Self { db, stop, notes, removed_notes, changed_notes_count, last_update_time: None }
    }

    #[inline(always)]
    fn update(&self) {
        self.db.update(&self.notes, &self.removed_notes)
    }

    #[inline(always)]
    fn curr_time() -> Duration {
        let start = SystemTime::now();
        start.duration_since(UNIX_EPOCH).expect("time went backwards")
    }

    #[inline]
    fn is_update_needed(&self) -> bool {
        let changed_notes_count = self.changed_notes_count.load(Ordering::Relaxed);
        changed_notes_count >= db::DB_INSERTION_NOTES_COUNT_THRESHOLD
        || (changed_notes_count != 0 && matches! {
            self.last_update_time,
            Some(time)
            if Self::curr_time() - time > db::DB_INSERTION_DURATION_THRESHOLD
        })
    }

    fn spawn(mut self) -> JoinHandle::<()> {
        actix_rt::spawn(async move {
            let mut shutdown = std::pin::pin!(signal::ctrl_c());
            loop {
                tokio::select! {
                    _ = &mut shutdown => {
                        self.update();
                        break
                    },
                    _ = async {
                        if self.stop.load(Ordering::Relaxed) { return }
                        if self.is_update_needed() {
                            self.update();
                            self.changed_notes_count.store(0, Ordering::Relaxed);
                            self.last_update_time = Some(Self::curr_time());
                            actix_rt::time::sleep(Duration::from_secs(5)).await
                        } else {
                            actix_rt::time::sleep(Duration::from_secs(1)).await
                        }
                    } => {}
                }
            }
        })
    }
}

struct Server {
    notes: AtomicNotes,
    qr_bytes: web::Bytes,
    removed_notes: AtomicRemovedNotes,
    changed_notes_count: Arc::<AtomicUsize>
}

impl Server {
    #[inline(always)]
    fn insert_note(&self, note: Note) {
        _ = self.notes.insert(note.uuid, Arc::new(note))
    }
}

#[inline]
#[get("/qr.png")]
async fn qr_code(state: Data::<Server>) -> impl Responder {
    HttpResponse::Ok().content_type("image/png").body(web::Bytes::clone(&state.qr_bytes))
}

#[inline]
#[get("/notes")]
async fn get_notes(state: Data::<Server>) -> impl Responder {
    let notes = state.notes.iter().map(|e| Arc::clone(&e.value())).collect::<Vec::<_>>();
    HttpResponse::Ok().body(serde_json::to_string(&notes).unwrap())
}

#[inline]
#[post("/new-note")]
async fn new_note(state: Data::<Server>, note: Json::<Note>) -> impl Responder {
    state.changed_notes_count.fetch_add(1, Ordering::Relaxed);
    {
        let mut note = note.into_inner();
        note.db_status = NoteDbStatus::New;
        state.insert_note(note)
    }
    HttpResponse::Ok().finish()
}

#[put("/update-note")]
async fn update_note(state: Data::<Server>, json: Json::<json::Note>) -> impl Responder {
    let note = json.into_inner();
    if let Some(mut old_note) = state.notes.get_mut(&note.uuid) {
        let old_note = Arc::make_mut(&mut *old_note);
        old_note.uuid = note.uuid;
        old_note.title = note.title;
        old_note.status = note.status;
        old_note.mod_time = note.mod_time;
        old_note.db_status = NoteDbStatus::Updated;
        old_note.description = note.description;
        state.changed_notes_count.fetch_add(1, Ordering::Relaxed);
        HttpResponse::Ok().json(json!({"status": "note updated successfully"}))
    } else {
        HttpResponse::NotFound().json(json!({"status": "note not found"}))
    }
}

#[delete("/remove-note")]
async fn remove_note(state: Data::<Server>, json: Json::<json::Uuid>) -> impl Responder {
    let uuid = json.into_inner().uuid;
    if let Some((.., note)) = state.notes.remove(&uuid) {
        state.removed_notes.lock().unwrap().push(note);
        state.changed_notes_count.fetch_add(1, Ordering::Relaxed);
        HttpResponse::Ok().json(json!({"status": "note removed successfully"}))
    } else {
        HttpResponse::NotFound().json(json!({"status": "note not found"}))
    }
}

#[inline]
fn get_default_local_ip_addr() -> Option::<IpAddr> {
    let sock = UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("1.1.1.1:80").ok()?;
    sock.local_addr().ok().map(|addr| addr.ip())
}

#[actix_web::main]
async fn main() -> std::io::Result::<()> {
    let local_ip = get_default_local_ip_addr().unwrap_or_else(|| panic!("could not find local IP address"));
    env_logger::init_from_env(env_logger::Env::new().default_filter_or("info"));

    let db = Db::new();
    let notes = Arc::new(db.get_notes().unwrap());
    let removed_notes = Arc::new(Mutex::new(Vec::new()));
    let db_thread_stop = Arc::new(AtomicBool::new(false));
    let changed_notes_count = Arc::new(AtomicUsize::new(0));

    let db_thread = DbThread::new(
        db,
        Arc::clone(&db_thread_stop),
        Arc::clone(&notes),
        Arc::clone(&removed_notes),
        Arc::clone(&changed_notes_count)
    );

    let db_thread_handle = db_thread.spawn();

    let server = Data::new(Server {
        notes, removed_notes, changed_notes_count,
        qr_bytes: {
            let local_addr = format!("http://{local_ip}:{PORT}");
            let qr = QrCode::encode_text(&local_addr, QrCodeEcc::Low).expect("could not encode URL to QR code");
            gen_qr_png_bytes(&qr).expect("could not generate QR code image").into()
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
            .service(update_note)
            .service(Files::new("/", "static").index_file("index.html"))
    }).bind((local_ip, PORT))?.run().await?;

    db_thread_stop.store(true, Ordering::Relaxed);
    db_thread_handle.await.unwrap();

    Ok(())
}
