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
  const columns = document.querySelectorAll(".column");
  let draggedNote = null; // Store reference to the dragged note

  // Handle drag start
  document.addEventListener("dragstart", (e) => {
    if (e.target.classList.contains("note")) {
      draggedNote = e.target; // Store the dragged note
      e.target.classList.add("dragging");
    }
  });

  // Handle drag end
  document.addEventListener("dragend", (e) => {
    if (e.target.classList.contains("note")) {
      e.target.classList.remove("dragging");
      columns.forEach((column) => column.classList.remove("highlight"));
    }
  });

  // Allow dropping on columns
  columns.forEach((column) => {
    column.addEventListener("dragover", (e) => {
      e.preventDefault(); // Allow dropping
      column.classList.add("highlight"); // Highlight column

      // Remove previous status classes
      draggedNote.classList.remove("active", "completed", "archived");
      if (window.innerWidth < 610) {
        // Determine the correct column based on Y position
        const targetColumn = getColumnByYAxis(columns, e.clientY);
        if (targetColumn) {
          updateNoteStatus(targetColumn, draggedNote);
        }
      } else {
        // For wider screens, use dataset.column
        updateNoteStatus(column, draggedNote);
      }

      // Determine the drop position (Y-axis)
      const afterElement = getDragAfterElement(column, e.clientY);
      if (afterElement == null) {
        column.appendChild(draggedNote); // Append to the end if no element is below
      } else {
        column.insertBefore(draggedNote, afterElement); // Insert before the found element
      }
    });

    column.addEventListener("dragleave", () => {
      column.classList.remove("highlight");
    });

    column.addEventListener("drop", (e) => {
      e.preventDefault();
      column.classList.remove("highlight");

      // Confirm the dragged note adopts the target column's color
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

      draggedNote = null; // Clear the dragged note reference
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
