const API_BASE_URL = "";

window.addEventListener("load", async () => {
  const qrcodeContainer = document.getElementById("qrcode-container");

  fetch("/qr.png")
    .then((response) => {
      if (!response.ok) {
        throw new Error("Failed to fetch QR code");
      }
      return response.blob();
    })
    .then((blob) => {
      const img = document.createElement("img");
      const span = document.createElement("span");
      span.textContent = "QR code for your phone";
      img.src = URL.createObjectURL(blob);
      qrcodeContainer.innerHTML = "";
      qrcodeContainer.appendChild(img);
      qrcodeContainer.appendChild(span);
    })
    .catch((error) => {
      qrcodeContainer.innerHTML = "<span>Error loading QR Code</span>";
      console.error(error);
    });
});

async function fetchNotes() {
  try {
    const response = await fetch(`${API_BASE_URL}/notes`);
    if (!response.ok) throw new Error("failed to fetch notes");
    const notes = await response.json();
    displayNotes(notes);
  } catch (error) {
    console.error(error);
  }
}

function displayNotes(notes) {
  const notesContainer = document.getElementById("notes");
  notesContainer.innerHTML = "";
  notes.sort((a, b) => b.mod_time - a.mod_time);
  notes.forEach(note => {
    const noteElement = document.createElement("div");
    noteElement.className = "note";
    noteElement.setAttribute("uuid", note.uuid);
    noteElement.innerHTML = `
            <h3>${note.title}</h3>
            <p>${note.description}</p>
            <p><strong>Status:</strong> ${note.status}</p>
            <button onclick="removeNote('${note.uuid}')">Remove</button>
        `;
    notesContainer.appendChild(noteElement);
  });
}

document.getElementById("note-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = document.getElementById("title").value;
  const description = document.getElementById("description").value;

  const note = {
    title,
    description,
    status: "Active",
    mod_time: Math.floor(Date.now() / 1000),
  };

  try {
    const response = await fetch(`${API_BASE_URL}/new-note`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(note),
    });

    if (!response.ok) throw new Error("failed to add note");

    document.getElementById("note-form").reset();
    fetchNotes();
  } catch (error) {
    console.error(error);
  }
});

async function removeNote(uuid) {
  try {
    const response = await fetch(`${API_BASE_URL}/remove-note`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uuid: uuid })
    });

    if (!response.ok) throw new Error("Failed to remove note");

    const noteElement = document.querySelector(`.note[uuid="${uuid}"]`);
    if (noteElement) {
      noteElement.remove();
    }
  } catch (error) {
    console.error(error);
  }
}

fetchNotes();
