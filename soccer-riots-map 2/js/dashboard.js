// CrowdPulse Data Dashboard
//
// Upload an Excel (or CSV) file with 8 columns and this page turns it into
// stats and charts. It is pure data collection and visualization: no AI,
// and nothing is sent to a server. The file is read and charted right in
// the browser.
//
// The spreadsheet reader (SheetJS) is only downloaded the first time a file
// is chosen, so the other pages never pay for it. The charts are hand-built
// SVG and CSS, same as the gauges on the Analyze Match page, so there is no
// chart library either.
//
// The file has two halves. The "pure logic" half has no DOM access at all
// (parsing, validation, number crunching) so it can be tested on its own.
// The UI half below it builds the page.

(function () {
  'use strict';

  /* ===== pure logic start ===== */

  // SheetJS comes from its own CDN. The pinned release is tried first; the
  // "latest" alias is only a backup in case that exact URL ever goes away.
  const SHEETJS_URLS = [
    'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js',
    'https://cdn.sheetjs.com/xlsx-latest/package/dist/xlsx.full.min.js',
  ];
  const DEMO_FILE_URL = 'data/demo-incidents.xlsx';
  const MAX_FILE_BYTES = 5 * 1024 * 1024;
  const MAX_ROWS = 20000;
  const MAX_PROBLEMS_KEPT = 50;
  const SEVERE_THRESHOLD = 4;
  const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
  const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // The 8 columns the file must have. This is the one place that defines
  // them: the upload validation, the "expected columns" table on the page,
  // and the data table all read from this list. Header names are matched
  // loosely (case, spaces and punctuation are ignored, and the aliases
  // below also count), so "match type" and "Match_Type" both work.
  const COLUMNS = [
    {
      key: 'date', label: 'Date', name: 'Date', kind: 'date',
      aliases: ['date', 'incidentdate', 'matchdate', 'eventdate'],
      rule: 'A real Excel date, or text like 2023-07-08', example: '2023-07-08',
    },
    {
      key: 'sport', label: 'Sport', name: 'Sport', kind: 'text',
      aliases: ['sport', 'sporttype'],
      rule: 'Any text', example: 'Soccer',
    },
    {
      key: 'country', label: 'Country', name: 'Country', kind: 'text',
      aliases: ['country', 'nation'],
      rule: 'Any text', example: 'Brazil',
    },
    {
      key: 'matchType', label: 'Match Type', name: 'Match Type', kind: 'text',
      aliases: ['matchtype', 'competitiontype', 'fixturetype'],
      rule: 'Any text, like League, Cup, Final or Derby', example: 'Derby',
    },
    {
      key: 'attendance', label: 'Attendance', name: 'Attendance', kind: 'number', min: 0,
      aliases: ['attendance', 'crowdsize', 'crowd'],
      rule: 'A number, 0 or higher', example: '43713',
    },
    {
      key: 'injuries', label: 'Injuries', name: 'Injuries', kind: 'number', min: 0,
      aliases: ['injuries', 'injured'],
      rule: 'A number, 0 or higher', example: '12',
    },
    {
      key: 'arrests', label: 'Arrests', name: 'Arrests', kind: 'number', min: 0,
      aliases: ['arrests', 'arrested'],
      rule: 'A number, 0 or higher', example: '5',
    },
    {
      key: 'severity', label: 'Severity (1-5)', name: 'Severity', kind: 'number', min: 1, max: 5, integer: true,
      aliases: ['severity', 'severity15', 'severityrating', 'riotseverity'],
      rule: 'A whole number from 1 to 5', example: '4',
    },
  ];

  function normalizeHeader(value) {
    return String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function isBlank(value) {
    return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
  }

  // Maps each column key to the index of the header cell that matches it.
  function mapColumns(headerRow) {
    const map = {};
    if (!Array.isArray(headerRow)) return map;
    headerRow.forEach((cell, index) => {
      if (isBlank(cell)) return;
      const normalized = normalizeHeader(cell);
      COLUMNS.forEach((col) => {
        if (!(col.key in map) && col.aliases.indexOf(normalized) !== -1) map[col.key] = index;
      });
    });
    return map;
  }

  // The header row is usually row 1, but a title row or two above it is
  // fine: whichever of the first 10 rows matches the most column names wins.
  function findHeaderRow(aoa) {
    let best = { index: -1, found: 0, map: {} };
    const limit = Math.min(Array.isArray(aoa) ? aoa.length : 0, 10);
    for (let i = 0; i < limit; i++) {
      const map = mapColumns(aoa[i]);
      const found = Object.keys(map).length;
      if (found > best.found) best = { index: i, found, map };
    }
    return best;
  }

  function parseNumber(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string') {
      const cleaned = value.replace(/[,\s]/g, '');
      return /^-?\d*\.?\d+$/.test(cleaned) ? Number(cleaned) : null;
    }
    return null;
  }

  // Builds a UTC-midnight Date, or null if the parts aren't a real calendar
  // day (like February 30th) or the year is outside 1900 to 2100.
  function makeUtcDate(year, monthIndex, day) {
    if (year < 1900 || year > 2100) return null;
    const date = new Date(Date.UTC(year, monthIndex, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== monthIndex || date.getUTCDate() !== day) {
      return null;
    }
    return date;
  }

  // Excel stores dates as a day count, so a date cell normally arrives here
  // as a plain number. Text dates (2023-07-08 or 7/8/2023) are handled too.
  // Everything is worked out in UTC so the viewer's timezone can't shift a
  // date by a day.
  function parseDate(value) {
    if (value instanceof Date) {
      if (isNaN(value.getTime())) return null;
      return makeUtcDate(value.getFullYear(), value.getMonth(), value.getDate());
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || value < 1) return null;
      const date = new Date(EXCEL_EPOCH_MS + Math.floor(value) * 86400000);
      return makeUtcDate(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    }
    if (typeof value === 'string') {
      const text = value.trim();
      let match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/.exec(text);
      if (match) return makeUtcDate(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
      match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
      if (match) return makeUtcDate(Number(match[3]), Number(match[1]) - 1, Number(match[2]));
    }
    return null;
  }

  function cleanText(value) {
    if (isBlank(value)) return null;
    return String(value).replace(/\s+/g, ' ').trim();
  }

  function numberRuleMessage(col) {
    if (col.integer && col.min !== undefined && col.max !== undefined) {
      return `${col.name} must be a whole number from ${col.min} to ${col.max}`;
    }
    if (col.min === 0 && col.max === undefined) return `${col.name} can't be negative`;
    return `${col.name} is out of range`;
  }

  // Checks one spreadsheet row. Returns { row } with clean, typed values, or
  // { message } saying what was wrong with it.
  function validateRow(cells, map, canon) {
    const out = {};
    for (const col of COLUMNS) {
      const raw = cells[map[col.key]];
      if (col.kind === 'date') {
        const date = parseDate(raw);
        if (!date) return { message: `${col.name} is missing or not a valid date (use a real Excel date or YYYY-MM-DD)` };
        out.date = date;
        out.dateISO = date.toISOString().slice(0, 10);
        out.year = date.getUTCFullYear();
        out.month = date.getUTCMonth();
      } else if (col.kind === 'text') {
        const text = cleanText(raw);
        if (text === null) return { message: `${col.name} is empty` };
        // "soccer" and "Soccer" are the same group; keep the first spelling seen.
        const key = text.toLowerCase();
        if (!canon[col.key].has(key)) canon[col.key].set(key, text);
        out[col.key] = canon[col.key].get(key);
      } else {
        const number = parseNumber(raw);
        if (number === null) return { message: `${col.name} must be a number` };
        if (col.integer && !Number.isInteger(number)) return { message: numberRuleMessage(col) };
        if ((col.min !== undefined && number < col.min) || (col.max !== undefined && number > col.max)) {
          return { message: numberRuleMessage(col) };
        }
        out[col.key] = number;
      }
    }
    return { row: out };
  }

  function rowIsBlank(cells, map) {
    if (!Array.isArray(cells)) return true;
    return COLUMNS.every((col) => isBlank(cells[map[col.key]]));
  }

  // Turns the sheet (an array of rows, each an array of cells) into clean
  // dataset rows. Bad rows are skipped and reported, not silently dropped.
  function buildDataset(aoa) {
    const labels = COLUMNS.map((col) => col.label).join(', ');
    if (!Array.isArray(aoa) || aoa.length === 0) {
      return { ok: false, error: 'That file looks empty. Add a header row and some data, then try again.' };
    }
    const header = findHeaderRow(aoa);
    if (header.found === 0) {
      return { ok: false, error: `Couldn't find the column headers. Put these ${COLUMNS.length} names in the first row of the sheet: ${labels}.` };
    }
    const missing = COLUMNS.filter((col) => !(col.key in header.map));
    if (missing.length) {
      return {
        ok: false,
        error: `Missing ${missing.length} column${missing.length === 1 ? '' : 's'}: ${missing.map((col) => col.label).join(', ')}. The sheet needs all ${COLUMNS.length}: ${labels}.`,
      };
    }

    const body = aoa.slice(header.index + 1);
    let nonBlank = 0;
    for (const cells of body) if (!rowIsBlank(cells, header.map)) nonBlank++;
    if (nonBlank === 0) {
      return { ok: false, error: 'The header row is there, but there are no data rows under it.' };
    }
    if (nonBlank > MAX_ROWS) {
      return { ok: false, error: `That sheet has ${nonBlank.toLocaleString('en-US')} rows. The limit is ${MAX_ROWS.toLocaleString('en-US')}.` };
    }

    const canon = {};
    COLUMNS.filter((col) => col.kind === 'text').forEach((col) => { canon[col.key] = new Map(); });

    const rows = [];
    const problems = [];
    let problemCount = 0;
    body.forEach((cells, i) => {
      if (rowIsBlank(cells, header.map)) return;
      const rowNumber = header.index + 2 + i;
      const result = validateRow(cells, header.map, canon);
      if (result.row) {
        result.row.sourceRow = rowNumber;
        rows.push(result.row);
      } else {
        problemCount++;
        if (problems.length < MAX_PROBLEMS_KEPT) problems.push({ row: rowNumber, message: result.message });
      }
    });

    if (rows.length === 0) {
      return { ok: false, error: `None of the ${nonBlank} data rows could be used. First problem: row ${problems[0].row}, ${problems[0].message}.` };
    }
    return { ok: true, rows, problems, problemCount, headerRowNumber: header.index + 1 };
  }

  function defaultFilters() {
    return { sport: '', country: '', matchType: '', minSeverity: 0, from: '', to: '' };
  }

  function applyFilters(rows, filters) {
    return rows.filter((row) =>
      (!filters.sport || row.sport === filters.sport) &&
      (!filters.country || row.country === filters.country) &&
      (!filters.matchType || row.matchType === filters.matchType) &&
      row.severity >= filters.minSeverity &&
      (!filters.from || row.dateISO >= filters.from) &&
      (!filters.to || row.dateISO <= filters.to)
    );
  }

  function sortRows(rows, key, dir) {
    const col = COLUMNS.find((c) => c.key === key) || COLUMNS[0];
    const sign = dir === 'asc' ? 1 : -1;
    const valueOf = (row) => (col.kind === 'date' ? row.dateISO : row[col.key]);
    return rows.slice().sort((a, b) => {
      const va = valueOf(a);
      const vb = valueOf(b);
      let cmp = typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb));
      if (cmp === 0) cmp = a.sourceRow - b.sourceRow;
      return cmp * sign;
    });
  }

  function summarize(rows) {
    const count = rows.length;
    let attendance = 0;
    let injuries = 0;
    let arrests = 0;
    let severitySum = 0;
    let severe = 0;
    let first = null;
    let last = null;
    for (const row of rows) {
      attendance += row.attendance;
      injuries += row.injuries;
      arrests += row.arrests;
      severitySum += row.severity;
      if (row.severity >= SEVERE_THRESHOLD) severe++;
      if (first === null || row.dateISO < first) first = row.dateISO;
      if (last === null || row.dateISO > last) last = row.dateISO;
    }
    return {
      incidents: count,
      attendance,
      injuries,
      arrests,
      avgSeverity: count ? severitySum / count : 0,
      severe,
      severePct: count ? (severe / count) * 100 : 0,
      injuriesPer10k: attendance > 0 ? (injuries / attendance) * 10000 : 0,
      firstDate: first,
      lastDate: last,
    };
  }

  function countBy(rows, key) {
    const counts = new Map();
    for (const row of rows) counts.set(row[key], (counts.get(row[key]) || 0) + 1);
    return Array.from(counts, ([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  }

  function averageBy(rows, groupKey, valueKey) {
    const groups = new Map();
    for (const row of rows) {
      const group = groups.get(row[groupKey]) || { sum: 0, count: 0 };
      group.sum += row[valueKey];
      group.count++;
      groups.set(row[groupKey], group);
    }
    return Array.from(groups, ([label, g]) => ({ label, value: g.sum / g.count, count: g.count }))
      .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
  }

  function severityDistribution(rows) {
    const counts = [0, 0, 0, 0, 0];
    for (const row of rows) counts[row.severity - 1]++;
    return counts.map((count, i) => ({ label: String(i + 1), value: count, severity: i + 1 }));
  }

  // Incidents over time: by month when the data covers three years or less,
  // by year otherwise, with empty periods filled in as zero so gaps show.
  function timeSeries(rows) {
    if (!rows.length) return { granularity: 'year', points: [] };
    let minIndex = Infinity;
    let maxIndex = -Infinity;
    for (const row of rows) {
      const index = row.year * 12 + row.month;
      if (index < minIndex) minIndex = index;
      if (index > maxIndex) maxIndex = index;
    }
    const monthly = maxIndex - minIndex + 1 <= 36;
    const counts = new Map();
    for (const row of rows) {
      const key = monthly ? row.year * 12 + row.month : row.year;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const points = [];
    if (monthly) {
      for (let index = minIndex; index <= maxIndex; index++) {
        const year = Math.floor(index / 12);
        points.push({ label: `${MONTH_NAMES[index % 12]} ${year}`, value: counts.get(index) || 0 });
      }
    } else {
      const minYear = Math.floor(minIndex / 12);
      const maxYear = Math.floor(maxIndex / 12);
      for (let year = minYear; year <= maxYear; year++) {
        points.push({ label: String(year), value: counts.get(year) || 0 });
      }
    }
    return { granularity: monthly ? 'month' : 'year', points };
  }

  function pearson(xs, ys) {
    const n = xs.length;
    if (n < 3) return null;
    const meanX = xs.reduce((s, v) => s + v, 0) / n;
    const meanY = ys.reduce((s, v) => s + v, 0) / n;
    let numerator = 0;
    let spreadX = 0;
    let spreadY = 0;
    for (let i = 0; i < n; i++) {
      const dx = xs[i] - meanX;
      const dy = ys[i] - meanY;
      numerator += dx * dy;
      spreadX += dx * dx;
      spreadY += dy * dy;
    }
    if (spreadX === 0 || spreadY === 0) return null;
    return numerator / Math.sqrt(spreadX * spreadY);
  }

  function describeCorrelation(r) {
    if (r === null) return 'Not enough variation in the data to work out a relationship.';
    // Judge the rounded value, so the label always agrees with the r shown next to it.
    const strength = Math.abs(Math.round(r * 100) / 100);
    const label = strength < 0.2 ? 'almost no relationship'
      : strength < 0.4 ? 'a weak relationship'
      : strength < 0.7 ? 'a moderate relationship'
      : 'a strong relationship';
    const direction = strength < 0.2 ? '' : r > 0 ? ' (they tend to rise together)' : ' (one tends to fall as the other rises)';
    return `r = ${r.toFixed(2)}, ${label}${direction}.`;
  }

  // Round, readable axis tick values from 0 up to just past the max.
  function niceTicks(maxValue, target, integer) {
    const max = maxValue > 0 ? maxValue : 1;
    const rawStep = max / target;
    const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const residual = rawStep / magnitude;
    let step = (residual <= 1 ? 1 : residual <= 2 ? 2 : residual <= 5 ? 5 : 10) * magnitude;
    if (integer) step = Math.max(1, Math.ceil(step));
    const steps = Math.ceil(max / step - 1e-9);
    const ticks = [];
    for (let i = 0; i <= steps; i++) ticks.push(Math.round(i * step * 1e6) / 1e6);
    return ticks;
  }

  // Teal for low severity through gold to red for high, same idea as the map
  // markers, but lighter so it reads on the dark chart cards.
  const SEVERITY_STOPS = [[47, 184, 167], [219, 168, 71], [232, 96, 60]];
  function severityShade(severity) {
    const t = Math.min(1, Math.max(0, (severity - 1) / 4));
    const segment = t < 0.5 ? 0 : 1;
    const local = t < 0.5 ? t / 0.5 : (t - 0.5) / 0.5;
    const a = SEVERITY_STOPS[segment];
    const b = SEVERITY_STOPS[segment + 1];
    const mix = (i) => Math.round(a[i] + (b[i] - a[i]) * local);
    return `rgb(${mix(0)}, ${mix(1)}, ${mix(2)})`;
  }

  // Keeps the biggest slices and folds the rest into "Other".
  function topNWithOther(items, n) {
    if (items.length <= n) return items;
    const head = items.slice(0, n - 1);
    const other = items.slice(n - 1).reduce((sum, item) => sum + item.count, 0);
    return head.concat([{ label: 'Other', count: other }]);
  }

  function formatNumber(n) {
    return Math.round(n).toLocaleString('en-US');
  }

  function formatDecimal(n, digits) {
    return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  function formatCompact(n) {
    const abs = Math.abs(n);
    if (abs >= 1e6) return `${parseFloat((n / 1e6).toFixed(1))}M`;
    if (abs >= 1e3) return `${parseFloat((n / 1e3).toFixed(1))}k`;
    return String(parseFloat(n.toFixed(1)));
  }

  function formatBytes(bytes) {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  /* ===== pure logic end ===== */

  // ------------------------------------------------------------------
  // UI
  // ------------------------------------------------------------------

  const PALETTE = ['#f0916c', '#5fd4c4', '#dba847', '#a78bda', '#6aa5e8', '#e8799f', '#9ba0b0'];
  const PAGE_SIZE = 12;
  const SVG_NS = 'http://www.w3.org/2000/svg';

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function svgEl(tag, attrs) {
    const node = document.createElementNS(SVG_NS, tag);
    Object.keys(attrs || {}).forEach((name) => node.setAttribute(name, attrs[name]));
    return node;
  }

  function svgText(attrs, text) {
    const node = svgEl('text', attrs);
    node.textContent = text;
    return node;
  }

  let sheetJsPromise = null;

  // Loads SheetJS the first time it's needed, trying each URL in turn.
  function loadSheetJs() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    if (sheetJsPromise) return sheetJsPromise;
    sheetJsPromise = SHEETJS_URLS.reduce(
      (attempt, url) => attempt.catch(() => new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = url;
        script.async = true;
        script.onload = () => (window.XLSX ? resolve(window.XLSX) : reject(new Error('XLSX missing after load')));
        script.onerror = () => { script.remove(); reject(new Error(`Could not load ${url}`)); };
        document.head.appendChild(script);
      })),
      Promise.reject(new Error('start'))
    ).catch((error) => {
      sheetJsPromise = null; // let a later attempt try again
      throw error;
    });
    return sheetJsPromise;
  }

  function init() {
    const section = document.getElementById('data-section');
    if (!section) return;

    const fileInput = document.getElementById('data-file-input');
    const dropzone = document.getElementById('data-dropzone');
    const demoButton = document.getElementById('data-load-demo');
    const statusEl = document.getElementById('data-status');
    const resultsEl = document.getElementById('data-results');
    const schemaBody = document.getElementById('data-schema-body');
    if (!fileInput || !dropzone || !demoButton || !statusEl || !resultsEl) return;

    const state = { fileName: '', rows: [], filters: defaultFilters(), sort: { key: 'date', dir: 'desc' }, page: 1 };
    let bodyEl = null;
    let countEl = null;
    let observers = [];

    // ---- expected-columns table (built from COLUMNS, so it can't drift) ----
    if (schemaBody) {
      COLUMNS.forEach((col) => {
        const tr = el('tr');
        tr.appendChild(el('th', null, col.label));
        tr.appendChild(el('td', null, col.rule));
        tr.appendChild(el('td', null, col.example));
        schemaBody.appendChild(tr);
      });
    }

    function setStatus(message, kind, extra) {
      statusEl.hidden = false;
      statusEl.className = `data-status${kind ? ` is-${kind}` : ''}`;
      statusEl.setAttribute('role', kind === 'error' ? 'alert' : 'status');
      statusEl.replaceChildren();
      statusEl.appendChild(el('p', null, message));
      if (extra) statusEl.appendChild(extra);
    }

    function problemsDetails(result) {
      const details = el('details', 'data-problems');
      details.appendChild(el('summary', null, `See the ${result.problemCount} skipped row${result.problemCount === 1 ? '' : 's'}`));
      const list = el('ul');
      result.problems.forEach((problem) => list.appendChild(el('li', null, `Row ${problem.row}: ${problem.message}`)));
      if (result.problemCount > result.problems.length) {
        list.appendChild(el('li', null, `...and ${result.problemCount - result.problems.length} more.`));
      }
      details.appendChild(list);
      return details;
    }

    // ---- reading files ----
    function pickSheet(XLSX, buffer) {
      const workbook = XLSX.read(new Uint8Array(buffer), { type: 'array' });
      const names = workbook.SheetNames || [];
      if (!names.length) throw new Error('The workbook has no sheets');
      let first = null;
      for (const name of names) {
        const aoa = XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, defval: null, blankrows: true, raw: true });
        if (!first) first = { sheetName: name, aoa };
        // Use the first sheet that has all 8 headers, so an extra notes sheet is ignored.
        if (findHeaderRow(aoa).found === COLUMNS.length) return { sheetName: name, aoa, sheetCount: names.length };
      }
      return { sheetName: first.sheetName, aoa: first.aoa, sheetCount: names.length };
    }

    function parseWorkbook(buffer, fileName) {
      return loadSheetJs().then(
        (XLSX) => {
          let picked;
          try {
            picked = pickSheet(XLSX, buffer);
          } catch (error) {
            console.error('Could not open the workbook:', error);
            setStatus("Couldn't open that file. Make sure it's a real Excel file and isn't password protected.", 'error');
            return;
          }
          const result = buildDataset(picked.aoa);
          if (!result.ok) {
            setStatus(result.error, 'error');
            return;
          }
          showDataset(result, fileName, picked.sheetName, picked.sheetCount);
        },
        (error) => {
          console.error('Could not load the spreadsheet reader:', error);
          setStatus("Couldn't load the spreadsheet reader. Check your internet connection and try again.", 'error');
        }
      );
    }

    function handleFile(file) {
      if (!/\.(xlsx|xls|csv)$/i.test(file.name)) {
        setStatus("That doesn't look like a spreadsheet. Choose an .xlsx, .xls or .csv file.", 'error');
        return;
      }
      if (file.size === 0) {
        setStatus('That file is empty.', 'error');
        return;
      }
      if (file.size > MAX_FILE_BYTES) {
        setStatus(`That file is ${formatBytes(file.size)}. The limit is ${formatBytes(MAX_FILE_BYTES)}.`, 'error');
        return;
      }
      setStatus(`Reading ${file.name}...`, 'info');
      file.arrayBuffer()
        .then((buffer) => parseWorkbook(buffer, file.name))
        .catch((error) => {
          console.error('Could not read the file:', error);
          setStatus("Couldn't read that file. Try saving it again as .xlsx and uploading it again.", 'error');
        });
    }

    function loadDemo() {
      setStatus('Loading the demo file...', 'info');
      fetch(DEMO_FILE_URL)
        .then((response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.arrayBuffer();
        })
        .then((buffer) => parseWorkbook(buffer, 'demo-incidents.xlsx'))
        .catch((error) => {
          console.error('Could not load the demo file:', error);
          setStatus("Couldn't load the demo file here. Use the Download demo file button and upload it instead.", 'error');
        });
    }

    fileInput.addEventListener('change', (event) => {
      const file = event.target.files && event.target.files[0];
      if (file) handleFile(file);
      event.target.value = ''; // lets the same file be picked again
    });
    demoButton.addEventListener('click', loadDemo);

    ['dragenter', 'dragover'].forEach((type) => {
      dropzone.addEventListener(type, (event) => {
        event.preventDefault();
        dropzone.classList.add('is-dragover');
      });
    });
    ['dragleave', 'drop'].forEach((type) => {
      dropzone.addEventListener(type, (event) => {
        event.preventDefault();
        dropzone.classList.remove('is-dragover');
      });
    });
    dropzone.addEventListener('drop', (event) => {
      const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
      if (file) handleFile(file);
    });

    // ---- showing a dataset ----
    function showDataset(result, fileName, sheetName, sheetCount) {
      state.fileName = fileName;
      state.rows = result.rows;
      state.filters = defaultFilters();
      state.sort = { key: 'date', dir: 'desc' };
      state.page = 1;

      let message = `Loaded ${formatNumber(result.rows.length)} incident${result.rows.length === 1 ? '' : 's'} from ${fileName}`;
      if (sheetCount > 1) message += ` (sheet "${sheetName}")`;
      message += '.';
      if (result.problemCount > 0) {
        message += ` ${result.problemCount} row${result.problemCount === 1 ? ' was' : 's were'} skipped because of problems.`;
        setStatus(message, 'warn', problemsDetails(result));
      } else {
        setStatus(message, 'success');
      }

      renderResults();
      if (typeof resultsEl.scrollIntoView === 'function') resultsEl.scrollIntoView({ block: 'start' });
    }

    function clearData() {
      disconnectObservers();
      state.rows = [];
      state.fileName = '';
      resultsEl.replaceChildren();
      resultsEl.hidden = true;
      statusEl.hidden = true;
      statusEl.replaceChildren();
    }

    function disconnectObservers() {
      observers.forEach((observer) => observer.disconnect());
      observers = [];
    }

    function renderResults() {
      disconnectObservers();
      resultsEl.replaceChildren();
      resultsEl.hidden = false;
      resultsEl.appendChild(buildFileBar());
      resultsEl.appendChild(buildFilters());
      bodyEl = el('div', 'data-body');
      resultsEl.appendChild(bodyEl);
      renderBody();
    }

    function buildFileBar() {
      const bar = el('div', 'data-filebar');
      const text = el('div', 'data-filebar-text');
      text.appendChild(el('p', 'data-filebar-name', state.fileName));
      const all = summarize(state.rows);
      text.appendChild(el('p', 'data-filebar-meta', `${formatNumber(all.incidents)} incidents · ${all.firstDate} to ${all.lastDate}`));
      bar.appendChild(text);
      const clear = el('button', 'data-button data-button--ghost', 'Clear data');
      clear.type = 'button';
      clear.addEventListener('click', clearData);
      bar.appendChild(clear);
      return bar;
    }

    function uniqueSorted(key) {
      return Array.from(new Set(state.rows.map((row) => row[key]))).sort((a, b) => a.localeCompare(b));
    }

    function buildFilters() {
      const wrap = el('div', 'data-filters');
      const controls = [];

      function addFilter(labelText, control, key, parse) {
        const field = el('div', 'data-filter');
        const id = `data-filter-${key}`;
        const label = el('label', null, labelText);
        label.setAttribute('for', id);
        control.id = id;
        control.addEventListener('change', () => {
          state.filters[key] = parse ? parse(control.value) : control.value;
          state.page = 1;
          renderBody();
        });
        field.appendChild(label);
        field.appendChild(control);
        wrap.appendChild(field);
        controls.push({ control, key });
      }

      function addSelect(labelText, key, values) {
        const select = el('select');
        const all = el('option', null, 'All');
        all.value = '';
        select.appendChild(all);
        values.forEach((value) => {
          const option = el('option', null, value);
          option.value = value;
          select.appendChild(option);
        });
        addFilter(labelText, select, key);
      }

      addSelect('Sport', 'sport', uniqueSorted('sport'));
      addSelect('Country', 'country', uniqueSorted('country'));
      addSelect('Match type', 'matchType', uniqueSorted('matchType'));

      const severity = el('select');
      [['0', 'Any'], ['3', '3 or higher'], ['4', '4 or higher'], ['5', '5 only']].forEach(([value, text]) => {
        const option = el('option', null, text);
        option.value = value;
        severity.appendChild(option);
      });
      addFilter('Severity', severity, 'minSeverity', (value) => Number(value));

      const summary = summarize(state.rows);
      [['From', 'from'], ['To', 'to']].forEach(([text, key]) => {
        const input = el('input');
        input.type = 'date';
        input.min = summary.firstDate;
        input.max = summary.lastDate;
        addFilter(text, input, key);
      });

      const footer = el('div', 'data-filter data-filter--actions');
      countEl = el('p', 'data-filter-count');
      countEl.setAttribute('aria-live', 'polite');
      const reset = el('button', 'data-button data-button--ghost', 'Reset filters');
      reset.type = 'button';
      reset.addEventListener('click', () => {
        state.filters = defaultFilters();
        state.page = 1;
        controls.forEach(({ control, key }) => { control.value = key === 'minSeverity' ? '0' : ''; });
        renderBody();
      });
      footer.appendChild(countEl);
      footer.appendChild(reset);
      wrap.appendChild(footer);
      return wrap;
    }

    // ---- the dashboard body: re-drawn whenever a filter changes ----
    function renderBody() {
      disconnectObservers();
      const rows = applyFilters(state.rows, state.filters);
      if (countEl) countEl.textContent = `Showing ${formatNumber(rows.length)} of ${formatNumber(state.rows.length)} incidents`;
      bodyEl.replaceChildren();

      if (!rows.length) {
        bodyEl.appendChild(el('p', 'data-empty', 'No incidents match these filters. Try widening them or hit Reset filters.'));
        return;
      }
      bodyEl.appendChild(buildKpis(rows));
      bodyEl.appendChild(buildChartGrid(rows));
      bodyEl.appendChild(buildTableModule(rows));
    }

    function buildKpis(rows) {
      const s = summarize(rows);
      const cards = [
        ['Incidents', formatNumber(s.incidents), `${s.firstDate} to ${s.lastDate}`],
        ['Total attendance', formatNumber(s.attendance), `${formatNumber(s.attendance / s.incidents)} per incident`],
        ['Total injuries', formatNumber(s.injuries), `${formatDecimal(s.injuriesPer10k, 1)} per 10,000 fans`],
        ['Total arrests', formatNumber(s.arrests), `${formatDecimal(s.arrests / s.incidents, 1)} per incident`],
        ['Average severity', formatDecimal(s.avgSeverity, 1), 'out of 5'],
        [`Severe (${SEVERE_THRESHOLD}+)`, formatNumber(s.severe), `${formatDecimal(s.severePct, 0)}% of incidents`],
      ];
      const wrap = el('div', 'data-kpis');
      cards.forEach(([label, value, sub]) => {
        const card = el('div', 'data-kpi');
        card.appendChild(el('p', 'data-kpi-label', label));
        card.appendChild(el('p', 'data-kpi-value', value));
        card.appendChild(el('p', 'data-kpi-sub', sub));
        wrap.appendChild(card);
      });
      return wrap;
    }

    function makeModule(title, options) {
      const opts = options || {};
      const card = el('section', `data-module${opts.wide ? ' data-module--wide' : ''}${opts.tone ? ` data-module--${opts.tone}` : ''}`);
      card.appendChild(el('h3', 'data-module-title', title));
      const body = el('div', 'data-module-body');
      card.appendChild(body);
      if (opts.note) card.appendChild(el('p', 'data-module-note', opts.note));
      return { card, body };
    }

    // A box that draws its chart at whatever width it currently has, and
    // redraws if that width changes (window resize, or the page being
    // shown after being hidden).
    function makeChartHost(drawFn) {
      const host = el('div', 'data-chart');
      let lastWidth = 0;
      const redraw = () => {
        const width = Math.floor(host.clientWidth);
        if (!width || width === lastWidth) return;
        lastWidth = width;
        host.replaceChildren(drawFn(width));
      };
      if (typeof ResizeObserver === 'function') {
        const observer = new ResizeObserver(redraw);
        observer.observe(host);
        observers.push(observer);
      }
      requestAnimationFrame(redraw);
      return host;
    }

    function drawColumnChart(width, options) {
      const points = options.points;
      const height = 230;
      const margin = { top: 14, right: 10, bottom: 34, left: 42 };
      const plotW = Math.max(60, width - margin.left - margin.right);
      const plotH = height - margin.top - margin.bottom;
      const ticks = niceTicks(Math.max(1, ...points.map((p) => p.value)), 4, true);
      const yMax = ticks[ticks.length - 1];

      const svg = svgEl('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': options.ariaLabel });
      ticks.forEach((tick) => {
        const y = margin.top + plotH - (tick / yMax) * plotH;
        svg.appendChild(svgEl('line', { x1: margin.left, x2: margin.left + plotW, y1: y, y2: y, class: 'data-grid-line' }));
        svg.appendChild(svgText({ x: margin.left - 8, y: y + 4, 'text-anchor': 'end', class: 'data-axis-text' }, formatCompact(tick)));
      });

      const band = plotW / points.length;
      const barWidth = Math.max(3, Math.min(46, band * 0.72));
      const labelEvery = Math.ceil(points.length / Math.max(2, Math.floor(plotW / 60)));
      points.forEach((point, i) => {
        const x = margin.left + i * band + (band - barWidth) / 2;
        const barHeight = (point.value / yMax) * plotH;
        if (barHeight > 0) {
          const rect = svgEl('rect', {
            x, y: margin.top + plotH - barHeight, width: barWidth, height: barHeight, rx: 3,
            fill: options.colorFor(point),
          });
          const title = svgEl('title', {});
          title.textContent = `${point.label}: ${formatNumber(point.value)}`;
          rect.appendChild(title);
          svg.appendChild(rect);
        }
        if (i % labelEvery === 0) {
          svg.appendChild(svgText({ x: x + barWidth / 2, y: height - 12, 'text-anchor': 'middle', class: 'data-axis-text' }, point.label));
        }
      });
      return svg;
    }

    function drawScatter(width, options) {
      const points = options.points;
      const height = 300;
      const margin = { top: 14, right: 16, bottom: 46, left: 58 };
      const plotW = Math.max(60, width - margin.left - margin.right);
      const plotH = height - margin.top - margin.bottom;
      const xTicks = niceTicks(Math.max(1, ...points.map((p) => p.x)), 5, false);
      const yTicks = niceTicks(Math.max(1, ...points.map((p) => p.y)), 5, true);
      const xMax = xTicks[xTicks.length - 1];
      const yMax = yTicks[yTicks.length - 1];

      const svg = svgEl('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': options.ariaLabel });
      yTicks.forEach((tick) => {
        const y = margin.top + plotH - (tick / yMax) * plotH;
        svg.appendChild(svgEl('line', { x1: margin.left, x2: margin.left + plotW, y1: y, y2: y, class: 'data-grid-line' }));
        svg.appendChild(svgText({ x: margin.left - 8, y: y + 4, 'text-anchor': 'end', class: 'data-axis-text' }, formatCompact(tick)));
      });
      xTicks.forEach((tick) => {
        const x = margin.left + (tick / xMax) * plotW;
        svg.appendChild(svgEl('line', { x1: x, x2: x, y1: margin.top + plotH, y2: margin.top + plotH + 4, class: 'data-grid-line' }));
        svg.appendChild(svgText({ x, y: margin.top + plotH + 18, 'text-anchor': 'middle', class: 'data-axis-text' }, formatCompact(tick)));
      });
      svg.appendChild(svgText({ x: margin.left + plotW / 2, y: height - 6, 'text-anchor': 'middle', class: 'data-axis-title' }, 'Attendance'));
      svg.appendChild(svgText({
        x: 14, y: margin.top + plotH / 2, 'text-anchor': 'middle', class: 'data-axis-title',
        transform: `rotate(-90 14 ${margin.top + plotH / 2})`,
      }, 'Injuries'));

      points.forEach((point) => {
        const dot = svgEl('circle', {
          cx: margin.left + (point.x / xMax) * plotW,
          cy: margin.top + plotH - (point.y / yMax) * plotH,
          r: 4.5, fill: point.color, class: 'data-dot',
        });
        const title = svgEl('title', {});
        title.textContent = point.tip;
        dot.appendChild(title);
        svg.appendChild(dot);
      });
      return svg;
    }

    function buildBars(items, options) {
      const wrap = el('div', 'data-bars');
      const max = Math.max(1, ...items.map((item) => item.value));
      items.forEach((item) => {
        const row = el('div', 'data-bar-row');
        const label = el('span', 'data-bar-label', item.label);
        label.title = item.label;
        const track = el('div', 'data-bar-track');
        const fill = el('div', 'data-bar-fill');
        fill.style.width = `${(item.value / max) * 100}%`;
        if (options.colorFor) fill.style.background = options.colorFor(item);
        track.appendChild(fill);
        row.appendChild(label);
        row.appendChild(track);
        row.appendChild(el('span', 'data-bar-value', options.format(item.value)));
        wrap.appendChild(row);
      });
      return wrap;
    }

    function buildDonut(items) {
      const slices = topNWithOther(items, 6);
      const total = slices.reduce((sum, slice) => sum + slice.count, 0);
      const radius = 44;
      const circumference = 2 * Math.PI * radius;

      const wrap = el('div', 'data-donut-wrap');
      const svg = svgEl('svg', {
        viewBox: '0 0 120 120', class: 'data-donut', role: 'img',
        'aria-label': `Donut chart of match types: ${slices.map((s) => `${s.label} ${s.count}`).join(', ')}`,
      });
      svg.appendChild(svgEl('circle', { cx: 60, cy: 60, r: radius, fill: 'none', 'stroke-width': 16, class: 'data-donut-track' }));
      let offset = 0;
      slices.forEach((slice, i) => {
        const length = (slice.count / total) * circumference;
        const arc = svgEl('circle', {
          cx: 60, cy: 60, r: radius, fill: 'none', 'stroke-width': 16,
          stroke: PALETTE[i % PALETTE.length],
          'stroke-dasharray': `${length} ${circumference - length}`,
          'stroke-dashoffset': -offset,
          transform: 'rotate(-90 60 60)',
        });
        const title = svgEl('title', {});
        title.textContent = `${slice.label}: ${slice.count}`;
        arc.appendChild(title);
        svg.appendChild(arc);
        offset += length;
      });
      svg.appendChild(svgText({ x: 60, y: 62, 'text-anchor': 'middle', class: 'data-donut-total' }, formatNumber(total)));
      svg.appendChild(svgText({ x: 60, y: 76, 'text-anchor': 'middle', class: 'data-axis-text' }, 'incidents'));
      wrap.appendChild(svg);

      const legend = el('ul', 'data-legend');
      slices.forEach((slice, i) => {
        const item = el('li', 'data-legend-item');
        const swatch = el('span', 'data-legend-swatch');
        swatch.style.background = PALETTE[i % PALETTE.length];
        item.appendChild(swatch);
        item.appendChild(el('span', 'data-legend-label', slice.label));
        item.appendChild(el('span', 'data-legend-value', `${slice.count} (${formatDecimal((slice.count / total) * 100, 0)}%)`));
        legend.appendChild(item);
      });
      wrap.appendChild(legend);
      return wrap;
    }

    function buildChartGrid(rows) {
      const grid = el('div', 'data-grid');

      // 1. incidents over time
      const series = timeSeries(rows);
      const timeline = makeModule(`Incidents per ${series.granularity}`, {
        wide: true,
        note: series.granularity === 'month'
          ? 'Your data covers three years or less, so it is shown month by month.'
          : 'Your data covers more than three years, so it is shown year by year.',
      });
      const peak = series.points.reduce((a, b) => (b.value > a.value ? b : a), series.points[0]);
      timeline.body.appendChild(makeChartHost((width) => drawColumnChart(width, {
        points: series.points,
        colorFor: () => PALETTE[0],
        ariaLabel: `Column chart of incidents per ${series.granularity}, ${series.points.length} periods, busiest was ${peak.label} with ${peak.value}`,
      })));
      grid.appendChild(timeline.card);

      // 2. by sport
      const sports = countBy(rows, 'sport');
      const bySport = makeModule('Incidents by sport', {
        note: sports.length > 8 ? `Top 8 of ${sports.length} sports.` : null,
      });
      bySport.body.appendChild(buildBars(sports.slice(0, 8).map((s) => ({ label: s.label, value: s.count })), {
        format: formatNumber, colorFor: () => 'linear-gradient(90deg, #bf4a2a, #f0916c)',
      }));
      grid.appendChild(bySport.card);

      // 3. by country
      const countries = countBy(rows, 'country');
      const byCountry = makeModule('Incidents by country', {
        tone: 'teal',
        note: countries.length > 8 ? `Top 8 of ${countries.length} countries.` : null,
      });
      byCountry.body.appendChild(buildBars(countries.slice(0, 8).map((c) => ({ label: c.label, value: c.count })), {
        format: formatNumber, colorFor: () => 'linear-gradient(90deg, #146e64, #5fd4c4)',
      }));
      grid.appendChild(byCountry.card);

      // 4. severity breakdown
      const severity = makeModule('Severity breakdown', {
        tone: 'gold',
        note: 'How many incidents were rated 1 (lowest) through 5 (highest).',
      });
      severity.body.appendChild(makeChartHost((width) => drawColumnChart(width, {
        points: severityDistribution(rows),
        colorFor: (point) => severityShade(point.severity),
        ariaLabel: `Column chart of incidents by severity rating: ${severityDistribution(rows).map((p) => `rating ${p.label} has ${p.value}`).join(', ')}`,
      })));
      grid.appendChild(severity.card);

      // 5. match types
      const matchTypes = makeModule('Match type breakdown', { tone: 'violet' });
      matchTypes.body.appendChild(buildDonut(countBy(rows, 'matchType')));
      grid.appendChild(matchTypes.card);

      // 6. average severity by sport
      const avgSeverity = averageBy(rows, 'sport', 'severity').slice(0, 8);
      const severityBySport = makeModule('Average severity by sport', {
        tone: 'gold',
        note: 'The number in brackets is how many incidents each average is based on.',
      });
      severityBySport.body.appendChild(buildBars(
        avgSeverity.map((s) => ({ label: `${s.label} (${s.count})`, value: s.value })),
        { format: (v) => formatDecimal(v, 1), colorFor: (item) => severityShade(item.value) }
      ));
      grid.appendChild(severityBySport.card);

      // 7. average injuries by match type
      const avgInjuries = averageBy(rows, 'matchType', 'injuries').slice(0, 8);
      const injuriesByType = makeModule('Average injuries by match type', {
        tone: 'violet',
        note: 'The number in brackets is how many incidents each average is based on.',
      });
      injuriesByType.body.appendChild(buildBars(
        avgInjuries.map((s) => ({ label: `${s.label} (${s.count})`, value: s.value })),
        { format: (v) => formatDecimal(v, 1), colorFor: () => 'linear-gradient(90deg, #5b3f8f, #a78bda)' }
      ));
      grid.appendChild(injuriesByType.card);

      // 8. attendance vs injuries
      const stride = Math.max(1, Math.ceil(rows.length / 1500));
      const dots = rows.filter((_, i) => i % stride === 0).map((row) => ({
        x: row.attendance,
        y: row.injuries,
        color: severityShade(row.severity),
        tip: `${row.sport}, ${row.country}, ${row.dateISO}: ${formatNumber(row.attendance)} fans, ${row.injuries} injured, severity ${row.severity}`,
      }));
      const correlation = pearson(rows.map((r) => r.attendance), rows.map((r) => r.injuries));
      const scatter = makeModule('Attendance vs injuries', {
        wide: true,
        tone: 'teal',
        note: `Each dot is one incident, colored by severity. ${describeCorrelation(correlation)}${stride > 1 ? ` Showing every ${stride}th incident to keep it readable.` : ''}`,
      });
      scatter.body.appendChild(makeChartHost((width) => drawScatter(width, {
        points: dots,
        ariaLabel: `Scatter plot of attendance against injuries for ${rows.length} incidents`,
      })));
      grid.appendChild(scatter.card);

      return grid;
    }

    // ---- the data table ----
    function buildTableModule(rows) {
      const mod = makeModule('All incidents', { wide: true, tone: 'teal' });
      const sorted = sortRows(rows, state.sort.key, state.sort.dir);
      const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
      state.page = Math.min(Math.max(1, state.page), pageCount);
      const start = (state.page - 1) * PAGE_SIZE;
      const pageRows = sorted.slice(start, start + PAGE_SIZE);

      function refresh() {
        mod.card.replaceWith(buildTableModule(rows));
      }

      const wrap = el('div', 'data-table-wrap');
      const table = el('table', 'data-table');
      table.appendChild(el('caption', 'visually-hidden', 'All incidents in the loaded file. Use the column headings to sort.'));

      const headRow = el('tr');
      COLUMNS.forEach((col) => {
        const th = el('th');
        th.scope = 'col';
        const active = state.sort.key === col.key;
        th.setAttribute('aria-sort', active ? (state.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none');
        if (col.kind === 'number' || col.kind === 'date') th.className = 'is-numeric';
        const button = el('button', 'data-sort-btn', col.label + (active ? (state.sort.dir === 'asc' ? ' ▲' : ' ▼') : ''));
        button.type = 'button';
        button.addEventListener('click', () => {
          if (state.sort.key === col.key) {
            state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
          } else {
            state.sort = { key: col.key, dir: col.kind === 'text' ? 'asc' : 'desc' };
          }
          state.page = 1;
          refresh();
        });
        th.appendChild(button);
        headRow.appendChild(th);
      });
      const thead = el('thead');
      thead.appendChild(headRow);
      table.appendChild(thead);

      const tbody = el('tbody');
      pageRows.forEach((row) => {
        const tr = el('tr');
        COLUMNS.forEach((col) => {
          const td = el('td');
          if (col.key === 'date') {
            td.textContent = row.dateISO;
            td.className = 'is-numeric';
          } else if (col.key === 'severity') {
            td.className = 'is-numeric';
            const dot = el('span', 'data-sev-dot');
            dot.style.background = severityShade(row.severity);
            td.appendChild(dot);
            td.appendChild(document.createTextNode(String(row.severity)));
          } else if (col.kind === 'number') {
            td.textContent = formatNumber(row[col.key]);
            td.className = 'is-numeric';
          } else {
            td.textContent = row[col.key];
          }
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      wrap.appendChild(table);
      mod.body.appendChild(wrap);

      const pager = el('div', 'data-pager');
      pager.appendChild(el('p', 'data-pager-text',
        `Showing ${start + 1} to ${start + pageRows.length} of ${formatNumber(sorted.length)}`));
      const buttons = el('div', 'data-pager-buttons');
      const prev = el('button', 'data-button data-button--ghost', 'Previous');
      prev.type = 'button';
      prev.disabled = state.page <= 1;
      prev.addEventListener('click', () => { state.page -= 1; refresh(); });
      const next = el('button', 'data-button data-button--ghost', 'Next');
      next.type = 'button';
      next.disabled = state.page >= pageCount;
      next.addEventListener('click', () => { state.page += 1; refresh(); });
      buttons.appendChild(el('span', 'data-pager-page', `Page ${state.page} of ${pageCount}`));
      buttons.appendChild(prev);
      buttons.appendChild(next);
      pager.appendChild(buttons);
      mod.body.appendChild(pager);

      return mod.card;
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
