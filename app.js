/* ============================================================================
 * JSONL Viewer & Validator — client-side tool logic
 * ----------------------------------------------------------------------------
 * One input, one parse, two modes:
 *   View     — browse records in a searchable, expandable list; export valid
 *              records as a JSON array.
 *   Validate — check every line, report exact line numbers and parser errors,
 *              count valid/invalid/blank, optionally flag key mismatches, and
 *              export a plain-text report.
 *
 * Handles JSON Lines (.jsonl) and NDJSON (.ndjson) — the same format.
 * 100% client-side. No network calls. Never throws uncaught.
 * ========================================================================== */
(function () {
  "use strict";

  var mount = document.getElementById("tool");
  if (!mount) return;

  var RENDER_CAP = 1000;   // max record rows rendered at once
  var LARGE_INPUT = 5000;  // record count above which we cap rendering
  var MAX_ISSUE_ROWS = 2000;

  // Shared parse result, produced once and rendered by either mode.
  // records: { lineNo, ok, value | error }
  var records = [];
  var totalLines = 0;
  var blankCount = 0;
  var parsed = false;
  var mode = "view";
  var query = "";

  // ---- Build the UI -------------------------------------------------------
  mount.innerHTML = "";

  var dropzone = el("div", { className: "dropzone", id: "jv-dropzone", tabIndex: 0 });
  dropzone.setAttribute("role", "button");
  dropzone.setAttribute("aria-label", "Drop a .jsonl, .ndjson or .txt file here, or click to choose a file");
  dropzone.innerHTML =
    "<strong>Drop a .jsonl / .ndjson / .txt file here</strong><br>" +
    "<span>or click to choose a file — your data never leaves your browser</span>";

  var fileInput = el("input", { type: "file", id: "jv-file" });
  fileInput.accept = ".jsonl,.ndjson,.txt,application/json,text/plain";
  fileInput.style.display = "none";
  fileInput.setAttribute("aria-hidden", "true");
  fileInput.tabIndex = -1;

  var taLabel = el("label", { htmlFor: "jv-input" });
  taLabel.textContent = "JSON Lines / NDJSON input";
  taLabel.style.cssText = "display:block;font-weight:600;margin:14px 0 6px;";

  var textarea = el("textarea", { id: "jv-input" });
  textarea.setAttribute("spellcheck", "false");
  textarea.placeholder =
    '{"id": 1, "name": "Ada"}\n' +
    '{"id": 2, "name": "Linus"}\n' +
    "…one JSON object per line";

  // Mode bar — these buttons both switch mode and run it.
  var modeBar = el("div", { className: "controls" });
  modeBar.setAttribute("role", "group");
  modeBar.setAttribute("aria-label", "Choose what to do with the input");

  var viewBtn = el("button", { type: "button", id: "jv-view" });
  viewBtn.textContent = "View";
  viewBtn.title = "Browse the records one by one";

  var validateBtn = el("button", { type: "button", id: "jv-validate" });
  validateBtn.textContent = "Validate";
  validateBtn.title = "Check that every line is valid JSON";

  modeBar.appendChild(viewBtn);
  modeBar.appendChild(validateBtn);

  // View-mode controls
  var viewControls = el("div", { className: "controls", id: "jv-view-controls" });

  var searchLabel = el("label", { htmlFor: "jv-search" });
  searchLabel.textContent = "Search records";
  searchLabel.style.cssText = "position:absolute;left:-9999px;";

  var searchInput = el("input", { type: "text", id: "jv-search" });
  searchInput.placeholder = "Search records…";
  searchInput.style.cssText = "flex:1;min-width:160px;";

  var downloadBtn = el("button", { type: "button", className: "secondary", id: "jv-download" });
  downloadBtn.textContent = "Download valid as JSON array";
  downloadBtn.disabled = true;

  viewControls.appendChild(searchLabel);
  viewControls.appendChild(searchInput);
  viewControls.appendChild(downloadBtn);

  // Validate-mode controls
  var validateControls = el("div", { className: "controls", id: "jv-validate-controls" });

  var keyLabel = el("label", { htmlFor: "jv-keycheck" });
  keyLabel.style.cssText = "display:flex;align-items:center;gap:6px;font-size:.92rem;cursor:pointer;";
  var keyCheck = el("input", { type: "checkbox", id: "jv-keycheck" });
  keyCheck.style.cssText = "width:auto;";
  keyLabel.appendChild(keyCheck);
  keyLabel.appendChild(document.createTextNode("Also check key consistency"));

  var clearBtn = el("button", { type: "button", className: "secondary", id: "jv-clear" });
  clearBtn.textContent = "Clear";

  validateControls.appendChild(keyLabel);
  validateControls.appendChild(clearBtn);

  var summary = el("div", { id: "jv-summary" });
  summary.setAttribute("aria-live", "polite");
  summary.style.cssText = "margin:6px 0;color:var(--muted);";

  var output = el("div", { className: "output", id: "jv-output" });
  output.setAttribute("aria-live", "polite");

  mount.appendChild(dropzone);
  mount.appendChild(fileInput);
  mount.appendChild(taLabel);
  mount.appendChild(textarea);
  mount.appendChild(modeBar);
  mount.appendChild(viewControls);
  mount.appendChild(validateControls);
  mount.appendChild(summary);
  mount.appendChild(output);

  // ---- Events -------------------------------------------------------------
  dropzone.addEventListener("click", function () { fileInput.click(); });
  dropzone.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
  });
  ["dragenter", "dragover"].forEach(function (ev) {
    dropzone.addEventListener(ev, function (e) {
      e.preventDefault(); e.stopPropagation();
      dropzone.classList.add("dragover");
    });
  });
  ["dragleave", "dragend"].forEach(function (ev) {
    dropzone.addEventListener(ev, function (e) {
      e.preventDefault(); e.stopPropagation();
      dropzone.classList.remove("dragover");
    });
  });
  dropzone.addEventListener("drop", function (e) {
    e.preventDefault(); e.stopPropagation();
    dropzone.classList.remove("dragover");
    var files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length) readFile(files[0]);
  });
  fileInput.addEventListener("change", function () {
    if (fileInput.files && fileInput.files.length) readFile(fileInput.files[0]);
    fileInput.value = "";
  });

  viewBtn.addEventListener("click", function () { run("view"); });
  validateBtn.addEventListener("click", function () { run("validate"); });

  textarea.addEventListener("keydown", function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); run(mode); }
  });

  searchInput.addEventListener("input", function () {
    query = searchInput.value.trim().toLowerCase();
    if (mode === "view" && parsed) renderView();
  });

  keyCheck.addEventListener("change", function () {
    if (mode === "validate" && parsed) renderValidate();
  });

  downloadBtn.addEventListener("click", downloadValid);

  clearBtn.addEventListener("click", function () {
    textarea.value = "";
    records = []; totalLines = 0; blankCount = 0; parsed = false;
    output.innerHTML = "";
    downloadBtn.disabled = true;
    renderIdleSummary();
    textarea.focus();
  });

  // ---- File reading -------------------------------------------------------
  function readFile(file) {
    if (!file) return;
    try {
      var reader = new FileReader();
      reader.onload = function () {
        textarea.value = typeof reader.result === "string" ? reader.result : "";
        run(mode);
      };
      reader.onerror = function () {
        showError("Could not read that file. Try pasting the text instead.");
      };
      reader.readAsText(file);
    } catch (err) {
      showError("Could not read that file: " + friendly(err));
    }
  }

  // ---- Shared parse -------------------------------------------------------
  function run(nextMode) {
    setMode(nextMode);
    parseInput();
    if (mode === "validate") renderValidate(); else renderView();
  }

  function setMode(next) {
    mode = next === "validate" ? "validate" : "view";
    var isView = mode === "view";
    viewControls.style.display = isView ? "" : "none";
    validateControls.style.display = isView ? "none" : "";
    viewBtn.className = isView ? "" : "secondary";
    validateBtn.className = isView ? "secondary" : "";
    viewBtn.setAttribute("aria-pressed", String(isView));
    validateBtn.setAttribute("aria-pressed", String(!isView));
  }

  function parseInput() {
    try {
      records = [];
      blankCount = 0;
      var text = textarea.value || "";
      // Strip a leading UTF-8 BOM. Files exported from Excel, PowerShell and most
      // .NET tooling carry one, and it would otherwise make a perfectly valid first
      // line fail to parse — the most misleading error this tool could give.
      if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
      var lines = text.split(/\r\n|\r|\n/);
      totalLines = lines.length;
      for (var i = 0; i < lines.length; i++) {
        var raw = lines[i];
        if (raw.trim() === "") { blankCount++; continue; }
        var rec = { lineNo: i + 1, ok: false };
        try {
          rec.value = JSON.parse(raw);
          rec.ok = true;
        } catch (err) {
          rec.error = cleanParseMessage(err);
        }
        records.push(rec);
      }
      parsed = true;
      query = searchInput.value.trim().toLowerCase();
      downloadBtn.disabled = !records.some(function (r) { return r.ok; });
    } catch (err) {
      parsed = false;
      showError("Something went wrong while parsing: " + friendly(err));
    }
  }

  function counts() {
    var invalid = 0;
    for (var i = 0; i < records.length; i++) if (!records[i].ok) invalid++;
    return { total: records.length, invalid: invalid, valid: records.length - invalid };
  }

  // ---- View mode ----------------------------------------------------------
  function renderView() {
    try {
      var c = counts();
      if (c.total === 0) {
        renderIdleSummary();
        output.innerHTML = "";
        return;
      }
      summary.textContent =
        c.valid.toLocaleString() + " record" + plural(c.valid) +
        " · " + c.invalid.toLocaleString() + " invalid" +
        (blankCount ? " · " + blankCount.toLocaleString() + " blank" : "");

      output.innerHTML = "";

      var matches = records.filter(function (r) {
        if (!query) return true;
        return haystack(r).indexOf(query) !== -1;
      });

      if (matches.length === 0) {
        output.appendChild(notice("No records match that search."));
        return;
      }

      var capped = matches.length > LARGE_INPUT;
      var slice = capped ? matches.slice(0, RENDER_CAP) : matches;
      if (capped) {
        output.appendChild(notice(
          "Showing the first " + RENDER_CAP.toLocaleString() + " of " +
          matches.length.toLocaleString() + " matching records to stay responsive. " +
          "Narrow it with search, or download the full valid set."
        ));
      }

      var frag = document.createDocumentFragment();
      for (var i = 0; i < slice.length; i++) {
        frag.appendChild(slice[i].ok ? validRow(slice[i]) : issueRow(slice[i].lineNo, slice[i].error));
      }
      output.appendChild(frag);
    } catch (err) {
      showError("Could not render the records: " + friendly(err));
    }
  }

  function validRow(rec) {
    var details = el("details");
    details.style.cssText =
      "border:1px solid var(--border);border-radius:8px;padding:8px 12px;margin:8px 0;background:#fff;";

    var sum = el("summary");
    sum.style.cssText =
      "cursor:pointer;font-family:ui-monospace,Consolas,monospace;font-size:.9rem;" +
      "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";

    var tag = el("span");
    tag.textContent = "Line " + rec.lineNo + ": ";
    tag.style.color = "var(--muted)";
    sum.appendChild(tag);
    sum.appendChild(document.createTextNode(preview(rec.value)));
    details.appendChild(sum);

    var pre = el("pre");
    pre.style.cssText =
      "white-space:pre-wrap;word-break:break-word;margin:.6rem 0 0;" +
      "font-family:ui-monospace,Consolas,monospace;font-size:.88rem;";
    try {
      pre.textContent = JSON.stringify(rec.value, null, 2);
    } catch (err) {
      pre.textContent = "[unable to stringify this value]";
    }
    details.appendChild(pre);
    return details;
  }

  // ---- Validate mode ------------------------------------------------------
  function renderValidate() {
    try {
      var c = counts();
      var nonBlank = c.total;

      if (textarea.value === "") {
        renderIdleSummary();
        showError("Nothing to validate yet — paste some JSON Lines text or drop a file above.");
        return;
      }

      var warnings = keyCheck.checked ? keyWarnings() : [];

      summary.textContent =
        c.valid.toLocaleString() + " valid · " +
        c.invalid.toLocaleString() + " invalid · " +
        blankCount.toLocaleString() + " blank · " +
        totalLines.toLocaleString() + " total line" + plural(totalLines);

      output.innerHTML = "";

      var banner = el("div");
      banner.style.cssText = "padding:12px 14px;border-radius:8px;font-weight:600;margin-bottom:10px;";
      if (c.invalid === 0) {
        banner.style.background = "#ecfdf5";
        banner.style.color = "#065f46";
        banner.style.border = "1px solid #a7f3d0";
        banner.textContent = "✓ All " + nonBlank + " line" + plural(nonBlank) + " are valid JSON";
      } else {
        banner.style.background = "#fef2f2";
        banner.style.color = "#991b1b";
        banner.style.border = "1px solid #fecaca";
        banner.textContent = "✗ " + c.invalid + " of " + nonBlank + " line" + plural(nonBlank) + " are invalid";
      }
      output.appendChild(banner);

      if (c.invalid > 0) {
        var jump = el("a", { href: "#" });
        jump.textContent = "Jump to first error ↓";
        jump.style.cssText = "display:inline-block;margin-bottom:10px;font-size:.92rem;";
        jump.addEventListener("click", function (e) {
          e.preventDefault();
          var first = output.querySelector(".error[data-row]");
          if (first && first.scrollIntoView) {
            first.scrollIntoView({ behavior: "smooth", block: "center" });
            first.style.outline = "2px solid var(--accent)";
            setTimeout(function () { first.style.outline = ""; }, 1500);
          }
        });
        output.appendChild(jump);
      }

      if (c.invalid > 0 || warnings.length > 0) {
        var bar = el("div", { className: "controls" });
        bar.style.marginTop = "4px";
        var reportText = buildReport(c, warnings);

        var copyBtn = el("button", { type: "button", className: "secondary" });
        copyBtn.textContent = "Copy report";
        copyBtn.addEventListener("click", function () { copyToClipboard(reportText, copyBtn); });

        var dlBtn = el("button", { type: "button", className: "secondary" });
        dlBtn.textContent = "Download report";
        dlBtn.addEventListener("click", function () {
          downloadText(reportText, "jsonl-validation-report.txt");
        });

        bar.appendChild(copyBtn);
        bar.appendChild(dlBtn);
        output.appendChild(bar);
      }

      var list = el("div");
      list.style.cssText = "margin-top:10px;display:flex;flex-direction:column;gap:6px;";
      var frag = document.createDocumentFragment();
      var shown = 0;

      for (var i = 0; i < records.length && shown < MAX_ISSUE_ROWS; i++) {
        if (records[i].ok) continue;
        frag.appendChild(issueRow(records[i].lineNo, records[i].error));
        shown++;
      }
      for (var j = 0; j < warnings.length && shown < MAX_ISSUE_ROWS; j++) {
        frag.appendChild(warnRow(warnings[j].lineNo, warnings[j].message));
        shown++;
      }

      var remaining = (c.invalid + warnings.length) - shown;
      if (remaining > 0) {
        var more = el("p");
        more.style.cssText = "margin:8px 0 0;color:var(--muted);font-size:.9rem;";
        more.textContent = "… and " + remaining.toLocaleString() +
          " more. Download the report to see every line.";
        frag.appendChild(more);
      }

      if (frag.childNodes.length) {
        list.appendChild(frag);
        output.appendChild(list);
      }
    } catch (err) {
      showError("Unexpected error while validating: " + friendly(err));
    }
  }

  function keyWarnings() {
    var warnings = [];
    var firstSig = null;
    for (var i = 0; i < records.length; i++) {
      var rec = records[i];
      if (!rec.ok || !isPlainObject(rec.value)) continue;
      var keys = Object.keys(rec.value).sort();
      var sig = keys.join(" ");
      if (firstSig === null) { firstSig = sig; continue; }
      if (sig !== firstSig) {
        warnings.push({
          lineNo: rec.lineNo,
          message: "keys differ: " + (keys.length ? keys.join(", ") : "(none)")
        });
      }
    }
    return warnings;
  }

  function buildReport(c, warnings) {
    var lines = [];
    lines.push("JSONL Validation Report");
    lines.push(c.invalid === 0
      ? "Status: All " + c.total + " non-blank line" + plural(c.total) + " are valid JSON"
      : "Status: " + c.invalid + " of " + c.total + " non-blank line" + plural(c.total) + " are invalid");
    lines.push("Valid: " + c.valid + " | Invalid: " + c.invalid +
      " | Blank: " + blankCount + " | Total: " + totalLines);
    lines.push("");
    if (c.invalid > 0) {
      lines.push("Errors:");
      for (var i = 0; i < records.length; i++) {
        if (!records[i].ok) lines.push("  Line " + records[i].lineNo + ": " + records[i].error);
      }
      lines.push("");
    }
    if (warnings.length) {
      lines.push("Key-consistency warnings:");
      for (var j = 0; j < warnings.length; j++) {
        lines.push("  Line " + warnings[j].lineNo + ": " + warnings[j].message);
      }
    }
    return lines.join("\n");
  }

  // ---- Export -------------------------------------------------------------
  function downloadValid() {
    try {
      var valid = records.filter(function (r) { return r.ok; })
        .map(function (r) { return r.value; });
      downloadText(JSON.stringify(valid, null, 2), "records.json", "application/json");
    } catch (err) {
      showError("Could not build the download: " + friendly(err));
    }
  }

  function downloadText(text, filename, type) {
    try {
      var blob = new Blob([text], { type: type || "text/plain;charset=utf-8" });
      var url = URL.createObjectURL(blob);
      var a = el("a", { href: url, download: filename });
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 0);
    } catch (e) { /* never throw */ }
  }

  function copyToClipboard(text, btn) {
    var original = btn.textContent;
    var done = function () {
      btn.textContent = "Copied!";
      setTimeout(function () { btn.textContent = original; }, 1500);
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text, done); });
      } else {
        fallbackCopy(text, done);
      }
    } catch (e) { fallbackCopy(text, done); }
  }

  function fallbackCopy(text, done) {
    try {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;left:-9999px;";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      done();
    } catch (e) { /* give up silently */ }
  }

  // ---- Shared rendering helpers ------------------------------------------
  function issueRow(lineNo, message) {
    var div = el("div", { className: "error" });
    div.setAttribute("data-row", "error");
    div.style.margin = "0";
    div.textContent = "Line " + lineNo + ": " + message;
    return div;
  }

  function warnRow(lineNo, message) {
    var div = el("div");
    div.style.cssText =
      "padding:10px 12px;border-radius:8px;font-size:.92rem;" +
      "background:#fffbeb;color:#92400e;border:1px solid #fde68a;";
    div.textContent = "Line " + lineNo + ": " + message;
    return div;
  }

  function renderIdleSummary() {
    summary.textContent =
      "Nothing loaded yet — paste or drop JSON Lines, then press View or Validate.";
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

  // ---- Utilities ----------------------------------------------------------
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
    try { s = JSON.stringify(value); } catch (err) { s = String(value); }
    if (s === undefined) s = String(value);
    if (s.length > 140) s = s.slice(0, 140) + "…";
    return s;
  }

  function cleanParseMessage(err) {
    var msg = (err && err.message) ? err.message : "Invalid JSON";
    return String(msg).replace(/\s+/g, " ").trim();
  }

  function isPlainObject(v) {
    return v !== null && typeof v === "object" && !Array.isArray(v);
  }

  function friendly(err) {
    return (err && err.message) ? err.message : String(err);
  }

  function plural(n) { return n === 1 ? "" : "s"; }

  function el(tag, props) {
    var node = document.createElement(tag);
    if (props) {
      for (var k in props) {
        if (Object.prototype.hasOwnProperty.call(props, k)) node[k] = props[k];
      }
    }
    return node;
  }

  // ---- Init ---------------------------------------------------------------
  setMode("view");
  renderIdleSummary();
})();
