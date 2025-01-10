const API_BASE_URL = "";

let debounceTimers = {};

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
      <div class="note-header">
        <div class="note-title" contenteditable="true">${note.title}</div>
        <button class="delete-btn" onclick="removeNote('${note.uuid}')">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="25" height="25">
            <path d="M18 6L6 18M6 6l12 12" fill="none" stroke="red" stroke-width="4" stroke-linecap="square" stroke-linejoin="round" />
          </svg>
        </button>
      </div>
      <div class="note-description" contenteditable="true">${note.description}</div>
      <div class="status-container">
        <span class="status-label">Status:</span>
        <select class="note-status">
          <option value="Active" ${note.status === 'Active' ? 'selected' : ''}>Active</option>
          <option value="Completed" ${note.status === 'Completed' ? 'selected' : ''}>Completed</option>
          <option value="Archived" ${note.status === 'Archived' ? 'selected' : ''}>Archived</option>
        </select>
      </div>
    `;

    const titleElement = noteElement.querySelector('.note-title');
    const descriptionElement = noteElement.querySelector('.note-description');
    const statusElement = noteElement.querySelector('.note-status');

    [titleElement, descriptionElement].forEach(element => {
      element.addEventListener('blur', () => debouncedSaveNote(note.uuid));
      element.addEventListener('input', () => debouncedSaveNote(note.uuid));
    });

    statusElement.addEventListener('change', () => debouncedSaveNote(note.uuid));

    notesContainer.appendChild(noteElement);
  });
}

function debouncedSaveNote(uuid) {
  if (debounceTimers[uuid]) {
    clearTimeout(debounceTimers[uuid]);
  }

  debounceTimers[uuid] = setTimeout(() => {
    updateNote(uuid);
  }, 1000);
}

async function updateNote(uuid) {
  const noteElement = document.querySelector(`.note[uuid="${uuid}"]`);
  const updatedNote = {
    uuid,
    title: noteElement.querySelector('.note-title').textContent,
    description: noteElement.querySelector('.note-description').textContent,
    status: noteElement.querySelector('.note-status').value,
    mod_time: Math.floor(Date.now() / 1000)
  };

  try {
    const response = await fetch(`${API_BASE_URL}/update-note`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(updatedNote),
    });
    
    if (!response.ok) throw new Error("Failed to update note");
  } catch (error) {
    console.error(error);
  }
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
      method: "POST",
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

function setupCustomDropdown() {
  const statusContainers = document.querySelectorAll('.status-container');
  
  statusContainers.forEach(container => {
    const selectElement = container.querySelector('.note-status');
    const dropdown = document.createElement('div');
    dropdown.className = 'custom-dropdown';
    
    const selected = document.createElement('div');
    selected.className = 'custom-selected';
    selected.textContent = selectElement.options[selectElement.selectedIndex].textContent;
    
    const options = document.createElement('div');
    options.className = 'custom-options';
    
    Array.from(selectElement.options).forEach(option => {
      const optionDiv = document.createElement('div');
      optionDiv.textContent = option.textContent;
      optionDiv.className = option.value === selectElement.value ? 'selected' : '';
      optionDiv.addEventListener('click', () => {
        selected.textContent = option.textContent;
        selectElement.value = option.value;
        debouncedSaveNote(selectElement.closest('.note').getAttribute('uuid'));
        options.querySelectorAll('div').forEach(el => el.classList.remove('selected'));
        optionDiv.classList.add('selected');
        options.classList.remove('show');
      });
      options.appendChild(optionDiv);
    });
    
    dropdown.appendChild(selected);
    dropdown.appendChild(options);
    selected.addEventListener('click', () => options.classList.toggle('show'));
    container.replaceChild(dropdown, selectElement);
  });
}

document.addEventListener('DOMContentLoaded', setupCustomDropdown);
