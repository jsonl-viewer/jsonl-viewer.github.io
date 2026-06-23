/* ============================================================================
 * JSONL Viewer — client-side tool logic
 * ----------------------------------------------------------------------------
 * Parses JSON Lines input (pasted or dropped file), renders a searchable,
 * collapsible list of records, flags invalid lines, and offers a download of
 * the valid records as a JSON array. 100% client-side — no network calls.
 * ========================================================================== */
(function () {
  "use strict";

  var mount = document.getElementById("tool");
  if (!mount) return;

  var RENDER_CAP = 1000;     // max rows rendered at once for responsiveness
  var LARGE_INPUT = 5000;    // record count above which we cap rendering

  // Parsed records: { lineNo, ok, value | error }
  var records = [];
  var query = "";

  // ---- Build the UI -------------------------------------------------------
  mount.innerHTML = "";

  var dropzone = el("div", { className: "dropzone", id: "jv-dropzone" });
  dropzone.setAttribute("role", "button");
  dropzone.setAttribute("tabindex", "0");
  dropzone.setAttribute("aria-label", "Drop a .jsonl file here, or click to choose a file");
  dropzone.innerHTML =
    "<strong>Drop a .jsonl / .ndjson / .txt file here</strong><br>" +
    "<span>or click to choose a file — then it fills the box below</span>";

  var fileInput = el("input", { type: "file" });
  fileInput.accept = ".jsonl,.ndjson,.txt,application/json,text/plain";
  fileInput.style.display = "none";
  fileInput.setAttribute("aria-hidden", "true");
  fileInput.tabIndex = -1;

  var taLabel = el("label", { htmlFor: "jv-input", className: "jv-label" });
  taLabel.textContent = "JSON Lines input";
  taLabel.style.display = "block";
  taLabel.style.fontWeight = "600";
  taLabel.style.margin = "12px 0 6px";

  var textarea = el("textarea", { id: "jv-input" });
  textarea.placeholder =
    '{"id": 1, "name": "Ada"}\n{"id": 2, "name": "Linus"}\n…one JSON object per line';

  var controls = el("div", { className: "controls" });

  var viewBtn = el("button", { type: "button" });
  viewBtn.textContent = "View";

  var searchLabel = el("label", { htmlFor: "jv-search" });
  searchLabel.textContent = "Search records";
  searchLabel.className = "jv-visually-hidden";
  searchLabel.style.position = "absolute";
  searchLabel.style.left = "-9999px";

  var searchInput = el("input", { type: "text", id: "jv-search" });
  searchInput.placeholder = "Search records…";
  searchInput.style.flex = "1";
  searchInput.style.minWidth = "160px";

  var downloadBtn = el("button", { type: "button", className: "secondary" });
  downloadBtn.textContent = "Download valid as JSON array";
  downloadBtn.disabled = true;

  controls.appendChild(viewBtn);
  controls.appendChild(searchLabel);
  controls.appendChild(searchInput);
  controls.appendChild(downloadBtn);

  var summary = el("div", { id: "jv-summary" });
  summary.setAttribute("aria-live", "polite");
  summary.style.margin = "6px 0";
  summary.style.color = "var(--muted)";

  var output = el("div", { className: "output", id: "jv-output" });

  mount.appendChild(dropzone);
  mount.appendChild(fileInput);
  mount.appendChild(taLabel);
  mount.appendChild(textarea);
  mount.appendChild(controls);
  mount.appendChild(summary);
  mount.appendChild(output);

  // ---- Events -------------------------------------------------------------
  dropzone.addEventListener("click", function () { fileInput.click(); });
  dropzone.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fileInput.click();
    }
  });

  dropzone.addEventListener("dragover", function (e) {
    e.preventDefault();
    dropzone.classList.add("dragover");
  });
  dropzone.addEventListener("dragleave", function () {
    dropzone.classList.remove("dragover");
  });
  dropzone.addEventListener("drop", function (e) {
    e.preventDefault();
    dropzone.classList.remove("dragover");
    var files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length) readFile(files[0]);
  });

  fileInput.addEventListener("change", function () {
    if (fileInput.files && fileInput.files.length) readFile(fileInput.files[0]);
  });

  viewBtn.addEventListener("click", parseAndRender);

  // Ctrl/Cmd+Enter in the textarea triggers View
  textarea.addEventListener("keydown", function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      parseAndRender();
    }
  });

  searchInput.addEventListener("input", function () {
    query = searchInput.value.trim().toLowerCase();
    renderList();
  });

  downloadBtn.addEventListener("click", downloadValid);

  // ---- File reading -------------------------------------------------------
  function readFile(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        textarea.value = String(reader.result == null ? "" : reader.result);
        parseAndRender();
      } catch (err) {
        showError("Could not read that file: " + friendly(err));
      }
    };
    reader.onerror = function () {
      showError("Could not read that file. It may be too large or unreadable.");
    };
    try {
      reader.readAsText(file);
    } catch (err) {
      showError("Could not read that file: " + friendly(err));
    }
  }

  // ---- Parsing ------------------------------------------------------------
  function parseAndRender() {
    try {
      records = [];
      var text = textarea.value || "";
      var lines = text.split(/\r\n|\r|\n/);
      for (var i = 0; i < lines.length; i++) {
        var raw = lines[i];
        if (raw.trim() === "") continue; // ignore blank lines
        var rec = { lineNo: i + 1, ok: false };
        try {
          rec.value = JSON.parse(raw);
          rec.ok = true;
        } catch (err) {
          rec.error = friendly(err);
        }
        records.push(rec);
      }
      query = searchInput.value.trim().toLowerCase();
      renderSummary();
      renderList();
      downloadBtn.disabled = !records.some(function (r) { return r.ok; });
    } catch (err) {
      showError("Something went wrong while parsing: " + friendly(err));
    }
  }

  function renderSummary() {
    var total = records.length;
    var invalid = records.reduce(function (n, r) { return n + (r.ok ? 0 : 1); }, 0);
    var valid = total - invalid;
    if (total === 0) {
      summary.textContent = "No records yet — paste or drop JSON Lines, then press View.";
      return;
    }
    summary.textContent =
      valid + " record" + (valid === 1 ? "" : "s") +
      " · " + invalid + " invalid";
  }

  // ---- Rendering the record list ------------------------------------------
  function renderList() {
    try {
      output.innerHTML = "";

      if (records.length === 0) return;

      var matches = records.filter(function (r) {
        if (!query) return true;
        return haystack(r).indexOf(query) !== -1;
      });

      if (matches.length === 0) {
        output.appendChild(notice("No records match “" + searchInput.value + "”."));
        return;
      }

      var capped = matches.length > LARGE_INPUT;
      var slice = capped ? matches.slice(0, RENDER_CAP) : matches;

      if (capped) {
        output.appendChild(notice(
          "Showing the first " + RENDER_CAP.toLocaleString() +
          " of " + matches.length.toLocaleString() +
          " matching records to stay responsive. Use search to narrow results, " +
          "or download the full valid set."
        ));
      }

      var frag = document.createDocumentFragment();
      for (var i = 0; i < slice.length; i++) {
        frag.appendChild(slice[i].ok ? validRow(slice[i]) : errorRow(slice[i]));
      }
      output.appendChild(frag);
    } catch (err) {
      showError("Could not render the records: " + friendly(err));
    }
  }

  function validRow(rec) {
    var details = el("details");
    details.style.border = "1px solid var(--border)";
    details.style.borderRadius = "8px";
    details.style.padding = "8px 12px";
    details.style.margin = "8px 0";
    details.style.background = "#fff";

    var sum = el("summary");
    sum.style.cursor = "pointer";
    sum.style.fontFamily = "ui-monospace, Consolas, monospace";
    sum.style.fontSize = ".9rem";
    sum.style.whiteSpace = "nowrap";
    sum.style.overflow = "hidden";
    sum.style.textOverflow = "ellipsis";

    var tag = el("span");
    tag.textContent = "Line " + rec.lineNo + ": ";
    tag.style.color = "var(--muted)";
    sum.appendChild(tag);
    sum.appendChild(document.createTextNode(preview(rec.value)));
    details.appendChild(sum);

    var pre = el("pre");
    pre.style.whiteSpace = "pre-wrap";
    pre.style.wordBreak = "break-word";
    pre.style.margin = ".6rem 0 0";
    pre.style.fontFamily = "ui-monospace, Consolas, monospace";
    pre.style.fontSize = ".88rem";
    var pretty;
    try {
      pretty = JSON.stringify(rec.value, null, 2);
    } catch (err) {
      pretty = "[unable to stringify this value]";
    }
    pre.textContent = pretty;
    details.appendChild(pre);

    return details;
  }

  function errorRow(rec) {
    var div = el("div", { className: "error" });
    div.style.margin = "8px 0";
    div.textContent = "Line " + rec.lineNo + ": " + rec.error;
    return div;
  }

  // ---- Download -----------------------------------------------------------
  function downloadValid() {
    try {
      var valid = records.filter(function (r) { return r.ok; })
        .map(function (r) { return r.value; });
      var json = JSON.stringify(valid, null, 2);
      var blob = new Blob([json], { type: "application/json" });
      var url = URL.createObjectURL(blob);
      var a = el("a", { href: url, download: "records.json" });
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Release the object URL shortly after the click is handled.
      setTimeout(function () { URL.revokeObjectURL(url); }, 0);
    } catch (err) {
      showError("Could not build the download: " + friendly(err));
    }
  }

  // ---- Helpers ------------------------------------------------------------
  function haystack(rec) {
    if (rec._hay !== undefined) return rec._hay;
    var s;
    if (rec.ok) {
      try { s = JSON.stringify(rec.value); } catch (e) { s = ""; }
    } else {
      s = "line " + rec.lineNo + " " + (rec.error || "");
    }
    rec._hay = (s || "").toLowerCase();
    return rec._hay;
  }

  function preview(value) {
    var s;
    try {
      s = JSON.stringify(value);
    } catch (err) {
      s = String(value);
    }
    if (s === undefined) s = String(value);
    if (s.length > 140) s = s.slice(0, 140) + "…";
    return s;
  }

  function notice(text) {
    var p = el("p", { className: "notice" });
    p.textContent = text;
    return p;
  }

  function showError(message) {
    output.innerHTML = "";
    var div = el("div", { className: "error" });
    div.textContent = message;
    output.appendChild(div);
  }

  function friendly(err) {
    if (err && err.message) return err.message;
    return String(err);
  }

  function el(tag, props) {
    var node = document.createElement(tag);
    if (props) {
      for (var k in props) {
        if (Object.prototype.hasOwnProperty.call(props, k)) node[k] = props[k];
      }
    }
    return node;
  }

  renderSummary();
})();
