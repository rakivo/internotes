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

document.addEventListener("DOMContentLoaded", () => {
  // Add context menu HTML
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
  let draggedNote = null;
  let activeNote = null;

  // Make existing notes editable
  document.querySelectorAll('.note-title, .note-description').forEach(element => {
    element.setAttribute('contenteditable', 'true');
    element.addEventListener('focus', handleElementFocus);
    element.addEventListener('blur', handleElementBlur);
  });

  // Handle focus and blur events for editable elements
  function handleElementFocus(e) {
    // Store the original content in case we need to revert
    e.target.dataset.originalContent = e.target.textContent;
    
    // Prevent drag start while editing
    const note = e.target.closest('.note');
    if (note) {
      note.draggable = false;
    }
  }

  function handleElementBlur(e) {
    // Re-enable dragging
    const note = e.target.closest('.note');
    if (note) {
      note.draggable = true;
    }

    // If content is empty, revert to original or set placeholder
    if (!e.target.textContent.trim()) {
      if (e.target.classList.contains('note-title')) {
        e.target.textContent = 'New Note';
      } else if (e.target.classList.contains('note-description')) {
        e.target.textContent = 'Add description...';
      }
    }
  }

  // Handle context menu
  document.addEventListener('contextmenu', (e) => {
    const noteElement = e.target.closest('.note');
    if (noteElement) {
      e.preventDefault();
      activeNote = noteElement;
      const contextMenu = document.querySelector('.context-menu');
      contextMenu.style.display = 'block';
      contextMenu.style.left = e.pageX + 25 + 'px';
      contextMenu.style.top = e.pageY + 'px';
    }
  });

  // Hide context menu when clicking elsewhere
  document.addEventListener('click', (e) => {
    const contextMenu = document.querySelector('.context-menu');
    if (!e.target.closest('.context-menu')) {
      contextMenu.style.display = 'none';
      activeNote = null;
    }
  });

  // Handle context menu actions
  document.querySelector('.context-menu').addEventListener('click', (e) => {
    const action = e.target.dataset.action;
    
    if (action === 'new' && activeNote) {
      const column = activeNote.closest('.column');
      const newNote = createNewNote(column.dataset.column);
      column.appendChild(newNote);
    } else if (action === 'edit' && activeNote) {
      // Focus on the title to start editing
      const titleElement = activeNote.querySelector('.note-title');
      titleElement.focus();
    } else if (action === 'delete' && activeNote) {
      activeNote.remove();
    }
    
    document.querySelector('.context-menu').style.display = 'none';
    activeNote = null;
  });

  function createNewNote(columnType) {
    const note = document.createElement('div');
    note.className = `note ${columnType}`;
    note.draggable = true;
    note.innerHTML = `
      <div class="note-title" contenteditable="true">New Note</div>
      <div class="note-description" contenteditable="true">Add description...</div>
    `;
    
    note.querySelectorAll('.note-title, .note-description').forEach(element => {
      element.addEventListener('focus', handleElementFocus);
      element.addEventListener('blur', handleElementBlur);
    });
    
    return note;
  }

  document.addEventListener("dragstart", (e) => {
    if (e.target.classList.contains("note")) {
      draggedNote = e.target;
      e.target.classList.add("dragging");
    }
  });

  document.addEventListener("dragend", (e) => {
    if (e.target.classList.contains("note")) {
      e.target.classList.remove("dragging");
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
        }
      } else {
        column.appendChild(draggedNote);
        updateNoteStatus(column, draggedNote);
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
    } else if (column.dataset.column === "completed") {
      note.classList.add("completed");
    } else if (column.dataset.column === "archived") {
      note.classList.add("archived");
    }
  }
});
