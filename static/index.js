const API_BASE_URL = "";
const debounceTimers = {};
let draggedNote = null;
let contextTarget = null;
let editingMode = false;
let activeNote = null;

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

document.addEventListener("DOMContentLoaded", () => {
  const contextMenu = document.createElement('div');
  contextMenu.className = 'context-menu';
  contextMenu.innerHTML = `
    <ul>
      <li data-action="new">New Note</li>
      <li data-action="edit">Edit</li>
      <li data-action="delete">Delete</li>
    </ul>
  `;
  document.body.appendChild(contextMenu);

  const columns = document.querySelectorAll(".column");

  async function fetchNotes() {
    try {
      const response = await fetch(`${API_BASE_URL}/notes`);
      if (!response.ok) throw new Error("Failed to fetch notes");
      const notes = await response.json();
      
      columns.forEach(column => {
        const existingNotes = column.querySelectorAll('.note');
        existingNotes.forEach(note => {
          if (!note.hasAttribute('being-dragged')) {
            note.remove();
          }
        });
      });

      notes.forEach(note => {
        const column = document.querySelector(`.column[data-column="${note.status.toLowerCase()}"]`);
        if (column) {
          column.appendChild(createNoteElement(note));
        }
      });
    } catch (error) {
      console.error("Error fetching notes:", error);
    }
  }

  fetchNotes().then(() => addPlaceholdersIfColumnEmpty());

  function createNoteElement(noteData) {
    const note = document.createElement('div');
    note.className = `note ${noteData.status.toLowerCase()}`;
    note.draggable = true;
    note.setAttribute('uuid', noteData.uuid);
    
    note.innerHTML = `
      <div class="note-title" contenteditable="false">${noteData.title}</div>
      <div class="note-description" contenteditable="false">${noteData.description}</div>
      <input type="hidden" class="status-input" value="${noteData.status}">
    `;
    
    note.querySelectorAll('.note-title, .note-description').forEach(element => {
      setupNoteElementListeners(element);
    });    

    return note;
  }

  // Handle context menu
  document.addEventListener('contextmenu', (e) => {
    const noteElement = e.target.closest('.note');
    if (noteElement) {
      e.preventDefault();
      contextTarget = e.target;
      editingMode = false;
      activeNote = noteElement;
      const contextMenu = document.querySelector('.context-menu');
      contextMenu.style.display = 'block';
      contextMenu.style.left = e.pageX + 'px';
      contextMenu.style.top = e.pageY + 'px';
    }
  });

  // Hide context menu when clicking elsewhere
  document.addEventListener('click', (e) => {
    const contextMenu = document.querySelector('.context-menu');
    if (!e.target.closest('.context-menu')) {
      contextMenu.style.display = 'none';
      activeNote = null;
      editingMode = false;
    }
  });

  // Handle context menu actions
  document.querySelector('.context-menu').addEventListener('click', async (e) => {
    const action = e.target.dataset.action;    
    if (action === 'new') {
      const column = activeNote ? activeNote.closest('.column') :
            e.target.closest('.column')
            || document.querySelector('.column[data-column="active"]');

      if (column) {
        const newNote = await createNewNote(column.dataset.column);
        column.appendChild(newNote);
      } else {
        console.error("No target column found for new note");
      }
    } else if (action === 'edit' && activeNote) {
      editingMode = true;

      // Focus immediately on the clicked field (title or description)
      const editableFields = activeNote.querySelectorAll('.note-title, .note-description');
      const targetField = contextTarget && (contextTarget.classList.contains('note-title') || contextTarget.classList.contains('note-description'))
        ? contextTarget
        : editableFields[0]; // Default to the title if no specific target is identified.

      editableFields.forEach((field) => {
        field.setAttribute('contenteditable', 'true');
      });

      // Focus and set caret position on the target field
      setTimeout(() => {
        targetField.focus();
        const range = document.createRange();
        const selection = window.getSelection();
        range.selectNodeContents(targetField);
        range.collapse(false); // Place caret at the end
        selection.removeAllRanges();
        selection.addRange(range);
      }, 0);

      const handleGlobalClick = (event) => {
        if (!event.target.closest('.note') || !event.target.closest('.note-title, .note-description')) {
          editableFields.forEach((field) => {
            field.setAttribute('contenteditable', 'false');
          });

          document.removeEventListener('click', handleGlobalClick);
          editingMode = false;
        }
      };

      editableFields.forEach((field) => {
        field.addEventListener('blur', () => {
          // Check if activeNote is still valid before proceeding
          if (activeNote) {
            field.setAttribute('contenteditable', 'false');
            editingMode = false;

            // Validate and ensure content is not empty
            if (!field.textContent.trim()) {
              field.textContent = field.classList.contains('note-title') ? 'New Note' : 'Add description...';
            }

            // Trigger a note update
            const uuid = activeNote.getAttribute('uuid');
            if (uuid) {
              updateNote(uuid);
            }

            activeNote = null;
          }
        });
      });

      setTimeout(() => {
        document.addEventListener('click', handleGlobalClick);
      }, 100);
    } else if (action === 'delete' && activeNote) {
      const uuid = activeNote.getAttribute('uuid');
      if (uuid) {
        await removeNote(uuid);
        addPlaceholdersIfColumnEmpty();
      }
    }
    
    document.querySelector('.context-menu').style.display = 'none';
    activeNote = null;
  });

  // Drag and drop handlers
  document.addEventListener("dragstart", (e) => {
    if (e.target.classList.contains("note")) {
      draggedNote = e.target;
      e.target.classList.add("dragging");
      e.target.setAttribute('being-dragged', 'true');
    }
  });

  document.addEventListener("dragend", (e) => {
    if (e.target.classList.contains("note")) {
      e.target.classList.remove("dragging");
      e.target.removeAttribute('being-dragged');
      columns.forEach((column) => column.classList.remove("highlight"));
    }
  });

  columns.forEach((column) => {
    column.addEventListener("dragover", (e) => {
      e.preventDefault();
      column.classList.add("highlight");

      draggedNote.classList.remove("active", "completed", "archived");
      if (window.innerWidth < 610) {
        const targetColumn = getColumnByYAxis(columns, e.clientY);
        if (targetColumn) {
          updateNoteStatus(targetColumn, draggedNote);
        }
      } else {
        updateNoteStatus(column, draggedNote);
      }

      const afterElement = getDragAfterElement(column, e.clientY);
      if (afterElement == null) {
        column.appendChild(draggedNote);
      } else {
        column.insertBefore(draggedNote, afterElement);
      }
    });

    column.addEventListener("dragleave", () => {
      column.classList.remove("highlight");
    });

    column.addEventListener("drop", (e) => {
      e.preventDefault();
      column.classList.remove("highlight");

      if (window.innerWidth < 610) {
        const targetColumn = getColumnByYAxis(columns, e.clientY);
        if (targetColumn) {
          targetColumn.appendChild(draggedNote);
          updateNoteStatus(targetColumn, draggedNote);
          const uuid = draggedNote.getAttribute('uuid');
          if (uuid) debouncedUpdateNote(uuid);
        }
      } else {
        column.appendChild(draggedNote);
        updateNoteStatus(column, draggedNote);
        const uuid = draggedNote.getAttribute('uuid');
        if (uuid) updateNote(uuid);
      }

      draggedNote = null;
    });
  });

  function getDragAfterElement(container, y) {
    const draggableElements = [...container.querySelectorAll(".note:not(.dragging)")];
    return draggableElements.reduce((closest, child) => {
      const box = child.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closest.offset) {
        return { offset: offset, element: child };
      } else {
        return closest;
      }
    }, { offset: Number.NEGATIVE_INFINITY }).element;
  }

  function getColumnByYAxis(columns, y) {
    return Array.from(columns).find((column) => {
      const box = column.getBoundingClientRect();
      return y >= box.top && y <= box.bottom;
    });
  }

  function updateNoteStatus(column, note) {
    if (column.dataset.column === "active") {
      note.classList.add("active");
      note.querySelector('.status-input').value = "Active";
    } else if (column.dataset.column === "completed") {
      note.classList.add("completed");
      note.querySelector('.status-input').value = "Completed";
    } else if (column.dataset.column === "archived") {
      note.classList.add("archived");
      note.querySelector('.status-input').value = "Archived";
    }
  }

  async function removeNote(uuid) {
    try {
      const response = await fetch(`${API_BASE_URL}/remove-note`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uuid: uuid })
      });
      if (!response.ok) throw new Error("Failed remove note");
      const noteElement = document.querySelector(`.note[uuid="${uuid}"]`);
      if (noteElement) {
        noteElement.remove();
      }
    } catch (error) {
      console.error(error);
    }
  }
});

function handleElementBlur(e) {
  const note = e.target.closest('.note');
  if (note) {
    note.draggable = true;
  }

  if (!e.target.textContent.trim()) {
    if (e.target.classList.contains('note-title')) {
      e.target.textContent = 'New Note';
    } else if (e.target.classList.contains('note-description')) {
      e.target.textContent = 'Add description...';
    }
  }
}

function debouncedUpdateNote(uuid) {
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
    status: noteElement.querySelector('.status-input').value,
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

function handleElementFocus(e) {
  e.target.dataset.originalContent = e.target.textContent;
  const note = e.target.closest('.note');
  if (note) {
    note.draggable = false;
  }
}

function setupNoteElementListeners(element) {
  if (editingMode) {
    element.setAttribute('contenteditable', 'true');
  } else {
    element.setAttribute('contenteditable', 'false');
  }

  element.addEventListener('focus', handleElementFocus);
  element.addEventListener('blur', handleElementBlur);
  element.addEventListener('input', (e) => {
    const note = element.closest('.note');
    if (note) {
      const uuid = note.getAttribute('uuid');
      if (uuid) {
        debouncedUpdateNote(uuid);
      }
    }
  });
}

async function createNewNote(columnType) {
  function uuidv4() {
    return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, c =>
      (+c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> +c / 4).toString(16)
    );
  }

  const uuid = uuidv4();
  const note = document.createElement('div');
  note.className = `note ${columnType}`;
  note.draggable = true;
  note.setAttribute('uuid', uuid);

  note.innerHTML = `
      <div class="note-title" contenteditable="false">New Note</div>
      <div class="note-description" contenteditable="false">Add description...</div>
      <input type="hidden" class="status-input" value="${columnType.charAt(0).toUpperCase() + columnType.slice(1)}">
    `;

  note.querySelectorAll('.note-title, .note-description').forEach(element => {
    setupNoteElementListeners(element);
  });

  try {
    const response = await fetch(`${API_BASE_URL}/new-note`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        uuid: note.getAttribute('uuid'),
        title: note.querySelector('.note-title').textContent,
        status: note.querySelector('.status-input').value,
        mod_time: Math.floor(Date.now() / 1000),
        description: note.querySelector('.note-description').textContent
      })
    });

    if (!response.ok) throw new Error("Failed to create new note");
  } catch (error) {
    console.error("Error creating new note:", error);
  }

  return note;
}

function addPlaceholdersIfColumnEmpty() {
  document.querySelectorAll(".column").forEach(column => {
    if (!column.querySelector('.note')) {
      const placeholder = document.createElement('div');
      placeholder.className = 'note placeholder-note';
      placeholder.draggable = false;

      placeholder.innerHTML = `
      <div class="note-title">+ Add Note</div>
    `;

      placeholder.addEventListener('click', async () => {
        const columnType = column.dataset.column.toLowerCase();
        const newNote = await createNewNote(columnType);
        column.replaceChild(newNote, placeholder);
        const title = newNote.querySelector('.note-title');
        title.setAttribute('contenteditable', 'true');
        title.focus();
        setupTabFocus(newNote);
      });

      column.appendChild(placeholder);
    }
  });
}

function setupTabFocus(note) {
  const title = note.querySelector('.note-title');
  const description = note.querySelector('.note-description');

  title.addEventListener('keydown', (event) => {
    if (event.key === 'Tab') {
      event.preventDefault();
      description.setAttribute('contenteditable', 'true');
      description.focus();
    }
  });
}
