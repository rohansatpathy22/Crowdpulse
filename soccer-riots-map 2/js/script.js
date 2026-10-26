// CrowdPulse
// Base map initialization

// ============================================================================
// Gemini API config — called directly from the browser (frontend-only,
// per project requirement), NOT via a Netlify Function.
//
// SECURITY NOTE: this means the keys below are visible to anyone who
// views this page's source or its Network tab once the site is deployed —
// they are not actually secret. Automated bots scan public sites and repos
// for exposed API keys; a leaked key can get its quota burned through or
// get auto-disabled by Google for a terms-of-service violation, even on
// a free tier. This is acceptable for a local/school-only demo that isn't
// pushed to a public repo or deployment — for anything public, move this
// back to a server-side call (see netlify/functions/enrich.js and
// chat.js from earlier in this project, which do exactly that) so the
// key never reaches the browser.
//
// Two separate keys, not one shared key: kept as separate keys for
// request-rate isolation between features — heavy testing of one
// doesn't eat into the other's per-minute/per-day quota. (Analyze
// Match originally used Google Search grounding here too, which has
// its own quota gated behind a Cloud Billing account being linked to
// the project — not something every user of this tool will have set
// up, so it was removed; see the comment on buildAnalyzePrompt below.
// Both keys now just do plain text generation.)
// ============================================================================
const GEMINI_API_KEY = 'primary'; // riot summaries (enrich) + chat
const GEMINI_ANALYZE_API_KEY = 'analyze'; // Analyze Match only
const GEMINI_MODEL = 'gemini-3.6-flash';

// Google sometimes answers 503 ("This model is currently experiencing high
// demand") for a few seconds at a time. That is a capacity problem on their
// side, not a bad key or bad request, so geminiFetch below retries before
// giving up: the main model once more after a short wait, then a lighter
// fallback model. The -latest alias always points at Google's current lite
// flash model, which usually has spare capacity when the main one is busy.
const GEMINI_FALLBACK_MODEL = 'gemini-flash-lite-latest';
const GEMINI_RETRY_DELAYS_MS = [1000, 2500];
const GEMINI_RETRYABLE_STATUSES = [429, 500, 502, 503, 504];

function geminiEndpointFor(model) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
}

// setTimeout that rejects with an AbortError if the request is cancelled
// while waiting (for example the user closes the popup mid-retry).
function sleepWithAbort(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

// Drop-in replacement for fetch() against the Gemini API. Resolves with a
// Response (ok or not) exactly like fetch, so callers keep their existing
// `if (!response.ok)` handling. Only overload/rate-limit/server errors are
// retried; anything else (bad key, bad request) comes straight back.
async function geminiFetch(apiKey, body, signal) {
  const attempts = [
    { model: GEMINI_MODEL, waitMs: 0 },
    { model: GEMINI_MODEL, waitMs: GEMINI_RETRY_DELAYS_MS[0] },
    { model: GEMINI_FALLBACK_MODEL, waitMs: GEMINI_RETRY_DELAYS_MS[1] },
  ];

  let mainModelFailure = null;

  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i];
    if (attempt.waitMs) await sleepWithAbort(attempt.waitMs, signal);

    const response = await fetch(geminiEndpointFor(attempt.model), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      signal,
      body: JSON.stringify(body),
    });

    if (response.ok) return response;

    if (attempt.model === GEMINI_MODEL) mainModelFailure = response;

    if (!GEMINI_RETRYABLE_STATUSES.includes(response.status)) {
      // Not an overload problem, so retrying won't help. If this came from
      // the fallback model, report the main model's error instead, since
      // that is the one that actually matters to the user.
      return attempt.model === GEMINI_MODEL ? response : mainModelFailure || response;
    }

    const isLastAttempt = i === attempts.length - 1;
    console.warn(
      `Gemini ${attempt.model} answered ${response.status}` +
        (isLastAttempt ? ', giving up.' : ', trying again...')
    );
  }

  // Every attempt was overloaded. Report the main model's failure.
  return mainModelFailure;
}

// Turns a failed Gemini request into something worth showing the user.
// error.status is attached where each request's non-ok response is turned
// into an Error.
function geminiErrorMessage(error, genericMessage) {
  const status = error && error.status;
  if (status === 429) {
    return 'The AI hit its usage limit for the moment. Give it a minute and try again.';
  }
  if (status === 500 || status === 502 || status === 503 || status === 504) {
    return "Google's AI is really busy right now. Give it a minute and try again.";
  }
  return genericMessage;
}

// Builds the summary-generation prompt for Gemini. The entire
// riotCoreFields object is passed through as-is so every field present
// (match context, crowd behavior flags, background factors,
// consequences, etc.) is available — the prompt below tells Gemini
// explicitly how to weave each category into the four output sections.
function buildGeminiEnrichPrompt(riotCoreFields) {
  return `You are writing a clear, factual, editorial-style summary of a soccer riot / crowd violence incident, based ENTIRELY on the structured event data below. Do not invent, assume, guess, or search for any additional facts — every claim in your summary must be directly traceable to a field in this data. If a field is missing or empty, simply don't mention it (never say "unknown" or speculate about it).

Event data (JSON):
${JSON.stringify(riotCoreFields, null, 2)}

Use ALL of the relevant fields present, organized into four parts:

1. "summary": A tight 1-2 sentence overview naming the teams (or participants), the competition, and what happened.
2. "description": A fuller, Wikipedia-style account covering the match context — sport, competition, home vs. away teams, final score and winner, attendance vs. stadium capacity, match importance, rivalry level — and exactly what occurred during the riot: when it began relative to the match, which crowd was responsible, and which specific behaviors took place. Only mention a behavior (pitch invasion, fighting, thrown objects, pyrotechnics, property damage, attacks on officials, crowd surges, hate-motivated incidents, gender-based abuse, weapons) if its corresponding field is explicitly true — never mention ones that are false or absent.
3. "causes": What led to the incident — the primary trigger, plus any contributing background factors that are explicitly true in the data (political, racial/ethnic, religious, or socioeconomic tensions; organized fan group involvement; alcohol or drug involvement; a history of previous incidents between these teams).
4. "impact": The aftermath, woven into a coherent paragraph rather than a bare list — deaths, injuries, arrests, estimated property damage, whether the match was abandoned, any sanctions issued, and the overall riot severity rating.

Respond with ONLY a single JSON object (no markdown code fences, no commentary before or after it), with exactly this shape:
{
  "summary": "...",
  "description": "...",
  "causes": "...",
  "impact": "...",
  "sources": []
}

Leave "sources" as an empty array — this summary is generated entirely from the provided data, not from external research.`;
}

// Builds the system instruction that grounds a chat conversation in a
// specific riot: both the core fields and whatever enrichment has
// already been shown to the user, so replies stay consistent with it.
function buildGeminiChatSystemInstruction(riotCoreFields, riotEnrichment) {
  return `You are answering follow-up questions about a specific real-world soccer riot / crowd violence incident, in a chat panel next to a popup that already shows the user some information about it.

Core event data (JSON):
${JSON.stringify(riotCoreFields, null, 2)}

Information already shown to the user in the popup (JSON):
${JSON.stringify(riotEnrichment, null, 2)}

Answer the user's questions about this specific event, staying consistent with the information already shown above — do not contradict it. You may add reasonable additional detail if you're confident it's accurate, but if you don't know something or can't verify it, say so plainly rather than inventing details. Keep replies conversational and reasonably concise, as this is a chat interface, not an article.`;
}

// Converts our { role: 'user' | 'assistant', content: string } history
// entries into the Gemini `contents` format, which uses role "user" or
// "model" and a `parts` array.
function geminiHistoryToContents(history) {
  return history
    .filter((entry) => entry && typeof entry.content === 'string')
    .map((entry) => ({
      role: entry.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: entry.content }],
    }));
}

// Attempts to parse Gemini's text response as the expected enrichment
// JSON shape. Gemini is asked to return raw JSON, but may still wrap it
// in markdown code fences or add stray whitespace/text, so this strips
// common wrapping before parsing. Returns null if parsing fails.
function tryParseGeminiStructuredResponse(text) {
  if (!text) return null;

  let cleaned = text.trim();

  const fenceMatch = cleaned.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  try {
    const parsed = JSON.parse(cleaned);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (err) {
    return null;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  // World bounds, used to keep panning within the real map (no infinite
  // horizontal/vertical scrolling past the edges of the world).
  const worldBounds = L.latLngBounds(
    L.latLng(-90, -180),
    L.latLng(90, 180)
  );

  // Core riot data, keyed by id, populated once the fetch below resolves.
  // Used to look up the full riot object when a marker is clicked.
  let riotsById = {};

  // Tracks which riot is currently open in the modal, for later use by
  // the enrich (Gemini) and chat calls.
  let currentRiotId = null;
  let currentRiot = null;

  // Holds the enrichment result (summary/description/causes/impact/etc.)
  // for the currently open riot, once the enrich fetch resolves. The chat
  // feature will use this as context for its requests later.
  let currentRiotEnrichment = null;

  // Holds the AbortController for the current in-flight "enrich" fetch.
  // Wired up so closing the modal can cancel any request that's still
  // pending.
  let currentEnrichAbortController = null;

  // Holds the AbortController for the current in-flight "analyze match"
  // fetch, so navigating away from the Analyze page cancels it.
  let currentAnalyzeAbortController = null;

  // Chat history for the currently open riot, as an array of
  // { role: 'user' | 'assistant', content: string } entries. Reset each
  // time a riot is opened/closed.
  let currentChatHistory = [];

  // Modal element references
  const riotModal = document.getElementById('riot-modal');
  const riotModalBackdrop = document.getElementById('riot-modal-backdrop');
  const riotModalContentEl = document.getElementById('riot-modal-content');
  const riotModalCloseBtn = document.getElementById('riot-modal-close');
  const riotChatCloseBtn = document.getElementById('riot-chat-close');
  const riotTitleEl = document.getElementById('riot-title');
  const riotDetailsIconEl = document.getElementById('riot-details-icon');
  const riotDetailsSubtitleEl = document.getElementById('riot-details-subtitle');
  const riotInfoContentEl = document.getElementById('riot-info-content');
  const riotSourcesEl = document.getElementById('riot-sources');

  // Accessible list-based alternative to the map markers (see the
  // comment in index.html — Leaflet markers aren't reliably keyboard-
  // or screen-reader-accessible on their own).
  const riotListEl = document.getElementById('riot-list');

  // Loading/error overlay shown over the map while data/riots.json
  // fetches (the map itself initializes immediately regardless).
  const mapLoadingEl = document.getElementById('map-loading');
  const mapErrorEl = document.getElementById('map-error');

  // Remembers whatever had focus right before the modal opened (e.g. a
  // riot-list button), so focus can be returned there when it closes.
  let lastFocusedElementBeforeModal = null;

  // Chat element references
  const chatMessagesEl = document.getElementById('chat-messages');
  const chatInputEl = document.getElementById('chat-input');
  const chatSendBtn = document.getElementById('chat-send');
  const chatInputRowEl = document.getElementById('chat-input-row');

  // Client-side cap on chat message length. Exceeding this shows an
  // inline warning instead of sending.
  const CHAT_MESSAGE_MAX_LENGTH = 500;

  // Inline warning shown below the input row (e.g. for over-length
  // messages), hidden by default. Created here rather than in the HTML
  // since it only ever needs to appear conditionally.
  const chatInputWarningEl = document.createElement('p');
  chatInputWarningEl.className = 'chat-input-warning';
  chatInputWarningEl.setAttribute('role', 'alert');
  chatInputWarningEl.hidden = true;
  chatInputRowEl.insertAdjacentElement('afterend', chatInputWarningEl);

  function showChatInputWarning(text) {
    chatInputWarningEl.textContent = text;
    chatInputWarningEl.hidden = false;
  }

  function hideChatInputWarning() {
    chatInputWarningEl.hidden = true;
  }

  // Clear the warning as soon as the user edits the input, so it doesn't
  // linger once they've started fixing the message.
  chatInputEl.addEventListener('input', hideChatInputWarning);

  // Renders the enrichment result (summary/description/causes/impact) as
  // labeled paragraphs inside #riot-info-content.
  function renderRiotEnrichment(enrichment) {
    riotInfoContentEl.innerHTML = '';

    const sections = [
      ['Summary', enrichment.summary],
      ['Description', enrichment.description],
      ['Causes', enrichment.causes],
      ['Impact', enrichment.impact],
    ];

    sections.forEach(([label, text]) => {
      if (!text) return;

      const sectionLabel = document.createElement('p');
      sectionLabel.className = 'riot-info-label';
      sectionLabel.textContent = label;

      const sectionBody = document.createElement('p');
      sectionBody.className = 'riot-info-body';
      sectionBody.textContent = text;

      riotInfoContentEl.appendChild(sectionLabel);
      riotInfoContentEl.appendChild(sectionBody);
    });
  }

  // Renders each entry in `sources` as a link inside #riot-sources.
  // Entries may be plain URL strings, or objects — object shape isn't
  // assumed beyond looking for a url-like and a title-like value, since
  // this is AI-fetched data with no fixed schema.
  function renderRiotSources(sources) {
    riotSourcesEl.innerHTML = '';

    if (!Array.isArray(sources)) return;

    sources.forEach((source) => {
      let url = null;
      let label = null;

      if (typeof source === 'string') {
        url = source;
        label = source;
      } else if (source && typeof source === 'object') {
        url = source.url || source.link || source.href || null;
        label = source.title || source.name || url;
      }

      if (!url) return;

      const link = document.createElement('a');
      link.href = url;
      link.textContent = label;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      riotSourcesEl.appendChild(link);
    });
  }

  // Shows an inline error message in #riot-info-content instead of
  // leaving it stuck on the loading state.
  function renderRiotEnrichmentError(error) {
    riotInfoContentEl.textContent = geminiErrorMessage(
      error,
      'Something went wrong loading information about this riot. Please try again.'
    );
  }

  // Small inline icons for the per-message avatars, keyed by role.
  // Kept inline (no image assets) so the chat UI matches the rest of
  // the site's no-external-images approach.
  const CHAT_AVATAR_ICONS = {
    assistant:
      '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 2L14.2 9.2L21 12L14.2 14.8L12 22L9.8 14.8L3 12L9.8 9.2L12 2Z" fill="currentColor"/></svg>',
    user:
      '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="8" r="3.5" fill="currentColor"/><path d="M4.5 20C5.5 15.5 8.4 13.5 12 13.5C15.6 13.5 18.5 15.5 19.5 20" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>',
    error:
      '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 3L22 20H2L12 3Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round" fill="none"/><path d="M12 9.5V14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="17" r="1" fill="currentColor"/></svg>',
  };

  // Builds a small avatar element for a chat row. `role` is 'assistant',
  // 'user', or 'error'.
  function createChatAvatar(role) {
    const avatar = document.createElement('span');
    avatar.className = `chat-avatar chat-avatar-${role}`;
    avatar.setAttribute('aria-hidden', 'true');
    avatar.innerHTML = CHAT_AVATAR_ICONS[role] || '';
    return avatar;
  }

  // Tiny, safe markdown renderer for AI replies: **bold**, *italic*,
  // `code`, numbered and bulleted lists, headings (shown as bold lines)
  // and paragraphs. Builds DOM nodes only, never innerHTML, so nothing
  // the model returns can inject markup.
  function appendInlineMarkdown(parent, text) {
    const pattern = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*|`[^`]+`)/g;
    let last = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      if (match.index > last) parent.appendChild(document.createTextNode(text.slice(last, match.index)));
      const token = match[0];
      let el;
      if (token.startsWith('**') || token.startsWith('__')) {
        el = document.createElement('strong');
        el.textContent = token.slice(2, -2);
      } else if (token.startsWith('`')) {
        el = document.createElement('code');
        el.textContent = token.slice(1, -1);
      } else {
        el = document.createElement('em');
        el.textContent = token.slice(1, -1);
      }
      parent.appendChild(el);
      last = match.index + token.length;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  function renderChatMarkdown(container, text) {
    const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
    let list = null;
    let listType = null;
    let para = null;

    const flush = () => {
      list = null;
      listType = null;
      para = null;
    };

    lines.forEach((rawLine) => {
      const line = rawLine.trimEnd();
      if (!line.trim()) {
        flush();
        return;
      }
      const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
      const bullet = line.match(/^\s*[-*\u2022]\s+(.*)$/);
      const heading = line.match(/^\s*#{1,6}\s+(.*)$/);

      if (ordered || bullet) {
        const type = ordered ? 'ol' : 'ul';
        if (!list || listType !== type) {
          list = document.createElement(type);
          listType = type;
          para = null;
          container.appendChild(list);
        }
        const li = document.createElement('li');
        appendInlineMarkdown(li, (ordered || bullet)[1]);
        list.appendChild(li);
        return;
      }

      list = null;
      listType = null;

      if (heading) {
        const p = document.createElement('p');
        const strong = document.createElement('strong');
        appendInlineMarkdown(strong, heading[1]);
        p.appendChild(strong);
        container.appendChild(p);
        para = null;
        return;
      }

      if (!para) {
        para = document.createElement('p');
        container.appendChild(para);
      } else {
        para.appendChild(document.createElement('br'));
      }
      appendInlineMarkdown(para, line.trim());
    });
  }

  // Appends a chat message row (avatar + bubble) to #chat-messages and
  // scrolls it into view. `role` is 'user' or 'assistant'.
  function appendChatMessage(role, text) {
    const row = document.createElement('div');
    row.className = `chat-row chat-row-${role}`;

    const avatar = createChatAvatar(role);
    const bubble = document.createElement('div');
    bubble.className = `chat-message chat-message-${role}`;
    if (role === 'assistant') {
      bubble.classList.add('chat-md');
      renderChatMarkdown(bubble, text);
    } else {
      bubble.textContent = text;
    }

    // User messages put the avatar after the bubble (right-hand side);
    // assistant messages put it before (left-hand side).
    if (role === 'user') {
      row.appendChild(bubble);
      row.appendChild(avatar);
    } else {
      row.appendChild(avatar);
      row.appendChild(bubble);
    }

    chatMessagesEl.appendChild(row);
    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
    return row;
  }

  // Appends a clearly-styled error row (distinct avatar + bubble) to
  // #chat-messages instead of crashing on a failed request.
  function appendChatErrorMessage(text) {
    const row = document.createElement('div');
    row.className = 'chat-row chat-row-error';

    const avatar = createChatAvatar('error');
    const bubble = document.createElement('div');
    bubble.className = 'chat-message chat-message-error';
    bubble.textContent = text;

    row.appendChild(avatar);
    row.appendChild(bubble);

    chatMessagesEl.appendChild(row);
    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
    return row;
  }

  // Shows a temporary "typing" indicator row (assistant avatar + three
  // pulsing dots) while waiting on the chat fetch. Returns the element
  // so it can be removed once the response (or error) arrives.
  function appendTypingIndicator() {
    const row = document.createElement('div');
    row.className = 'chat-row chat-row-assistant';

    const avatar = createChatAvatar('assistant');

    const bubble = document.createElement('div');
    bubble.className = 'chat-message chat-message-assistant chat-message-typing';

    for (let i = 0; i < 3; i++) {
      const dot = document.createElement('span');
      dot.className = 'chat-typing-dot';
      bubble.appendChild(dot);
    }

    row.appendChild(avatar);
    row.appendChild(bubble);

    chatMessagesEl.appendChild(row);
    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
    return row;
  }

  // Sends the current chat input as a message, calls the chat Netlify
  // Function with the riot context + history, and renders the reply (or
  // an error) as a chat bubble.
  function sendChatMessage() {
    const message = chatInputEl.value.trim();

    // Ignore empty/whitespace-only messages — don't call the API.
    if (!message) return;

    // Cap message length client-side; show an inline warning and don't
    // send if it's exceeded.
    if (message.length > CHAT_MESSAGE_MAX_LENGTH) {
      showChatInputWarning(
        `Message is too long (${message.length}/${CHAT_MESSAGE_MAX_LENGTH} characters). Please shorten it.`
      );
      return;
    }

    hideChatInputWarning();

    // Capture which riot this message belongs to, so the response can be
    // ignored if the modal is closed (or a different riot opened) before
    // it arrives.
    const riotForThisMessage = currentRiot;
    const riotIdForThisMessage = currentRiotId;

    if (!riotForThisMessage || !riotIdForThisMessage) return;

    // History sent to the server is everything before this new message.
    const historyForRequest = currentChatHistory.slice();

    // Render the user's message and add it to local history immediately.
    appendChatMessage('user', message);
    currentChatHistory.push({ role: 'user', content: message });
    chatInputEl.value = '';

    const typingIndicator = appendTypingIndicator();
    setTimeout(() => {
      if (!typingIndicator.isConnected) return;
      const bubble = typingIndicator.querySelector('.chat-message-typing');
      if (!bubble || bubble.querySelector('.chat-typing-note')) return;
      const note = document.createElement('span');
      note.className = 'chat-typing-note';
      note.textContent = 'Still thinking, the AI is busy...';
      bubble.appendChild(note);
      chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
    }, 4000);
    chatSendBtn.disabled = true;
    chatInputEl.disabled = true;

    geminiFetch(GEMINI_API_KEY, {
      system_instruction: {
        parts: [{ text: buildGeminiChatSystemInstruction(riotForThisMessage, currentRiotEnrichment) }],
      },
      contents: [
        ...geminiHistoryToContents(historyForRequest),
        { role: 'user', parts: [{ text: message }] },
      ],
    })
      .then((response) => {
        if (!response.ok) {
          return response.text().then((bodyText) => {
            console.error(`Gemini chat request failed: ${response.status} ${response.statusText}`, bodyText);
            const requestError = new Error(`Gemini chat request failed: ${response.status} ${response.statusText}`);
            requestError.status = response.status;
            throw requestError;
          });
        }
        return response.json();
      })
      .then((geminiData) => {
        typingIndicator.remove();

        // Ignore a stale response for a riot that's no longer open.
        if (currentRiotId !== riotIdForThisMessage) return;

        const candidate = geminiData && geminiData.candidates && geminiData.candidates[0];
        const parts = candidate && candidate.content && candidate.content.parts;
        const reply = Array.isArray(parts)
          ? parts.map((part) => part.text || '').join('').trim()
          : '';

        appendChatMessage('assistant', reply || 'No reply was returned.');
        currentChatHistory.push({ role: 'assistant', content: reply || 'No reply was returned.' });
      })
      .catch((error) => {
        typingIndicator.remove();

        if (currentRiotId !== riotIdForThisMessage) return;

        console.error('Error sending chat message to Gemini:', error);
        appendChatErrorMessage(
          geminiErrorMessage(error, 'Something went wrong sending that message. Please try again.')
        );
      })
      .finally(() => {
        if (currentRiotId === riotIdForThisMessage) {
          chatSendBtn.disabled = false;
          chatInputEl.disabled = false;
          chatInputEl.focus();
        }
      });
  }

  chatSendBtn.addEventListener('click', sendChatMessage);

  chatInputEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      sendChatMessage();
    }
  });

  // Fetches enrichment data (summary/description/causes/impact/sources)
  // for the given riot by calling the Gemini API directly from the
  // browser (see the security note about GEMINI_API_KEY at the top of
  // this file).
  function fetchRiotEnrichment(riot) {
    const controller = new AbortController();
    currentEnrichAbortController = controller;

    geminiFetch(
      GEMINI_API_KEY,
      { contents: [{ parts: [{ text: buildGeminiEnrichPrompt(riot) }] }] },
      controller.signal
    )
      .then((response) => {
        if (!response.ok) {
          return response.text().then((bodyText) => {
            console.error(`Gemini enrich request failed: ${response.status} ${response.statusText}`, bodyText);
            const requestError = new Error(`Gemini enrich request failed: ${response.status} ${response.statusText}`);
            requestError.status = response.status;
            throw requestError;
          });
        }
        return response.json();
      })
      .then((geminiData) => {
        // Ignore stale responses for a riot that's no longer open (e.g.
        // the user closed this modal and opened a different one before
        // this response arrived, without the earlier fetch having been
        // aborted in time).
        if (currentRiotId !== riot.id) return;

        const candidate = geminiData && geminiData.candidates && geminiData.candidates[0];
        const parts = candidate && candidate.content && candidate.content.parts;
        const rawText = Array.isArray(parts) ? parts.map((part) => part.text || '').join('') : '';

        const structured = tryParseGeminiStructuredResponse(rawText);

        let enrichment;
        if (structured) {
          enrichment = {
            summary: typeof structured.summary === 'string' ? structured.summary : '',
            description: typeof structured.description === 'string' ? structured.description : '',
            causes: typeof structured.causes === 'string' ? structured.causes : '',
            impact: typeof structured.impact === 'string' ? structured.impact : '',
            // The prompt instructs Gemini to leave this as an empty
            // array, since this summary is synthesized from the riot's
            // own metadata rather than external research — kept in the
            // shape regardless, so the sources renderer (which already
            // handles empty gracefully) doesn't need to change.
            sources: Array.isArray(structured.sources) ? structured.sources : [],
          };
        } else {
          // Structured parsing failed — fall back to the raw text rather
          // than crashing or losing the response entirely.
          enrichment = {
            summary: '',
            description: rawText || 'No information could be generated for this event.',
            causes: '',
            impact: '',
            sources: [],
          };
        }

        currentRiotEnrichment = enrichment;

        riotInfoContentEl.classList.remove('is-loading');
        renderRiotEnrichment(enrichment);
        renderRiotSources(enrichment.sources);
      })
      .catch((error) => {
        // An aborted request just means the user closed the modal (or a
        // new riot was opened) — that's expected, not an error, so don't
        // show an error message for it.
        if (error.name === 'AbortError') return;

        if (currentRiotId !== riot.id) return;

        console.error('Error fetching riot enrichment from Gemini:', error);
        riotInfoContentEl.classList.remove('is-loading');
        renderRiotEnrichmentError(error);
      });
  }

  // Returns the currently visible/focusable elements inside the modal
  // content card, in DOM order, for the Tab-trapping logic below.
  function getFocusableModalElements() {
    const selector =
      'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
    return Array.from(riotModalContentEl.querySelectorAll(selector)).filter(
      (el) => el.offsetParent !== null
    );
  }

  function openRiotModal(riot) {
    // Remember what had focus so it can be restored when the modal closes.
    lastFocusedElementBeforeModal = document.activeElement;

    currentRiotId = riot.id;
    currentRiot = riot;
    currentRiotEnrichment = null;
    currentChatHistory = [];
    chatMessagesEl.innerHTML = '';
    hideChatInputWarning();

    // Title
    riotTitleEl.textContent = riot.title;

    // Header icon color follows the same continuous severity gradient
    // as the map markers and list cards, so all three visualizations
    // agree. Falls back to the icon's default gradient when severity is
    // absent (color === null clears any inline override).
    riotDetailsIconEl.className = 'riot-window-icon';
    riotDetailsIconEl.style.background = getSeverityColor(riot.riotSeverity) || '';

    // Subtitle: "City, Country · Date", reusing the same builder as the
    // list cards so the two stay consistent.
    riotDetailsSubtitleEl.textContent = buildRiotListMeta(riot);

    // Loading state for AI-fetched content, shown until the enrich fetch
    // below resolves (or fails).
    riotInfoContentEl.textContent = 'Loading information about this riot...';
    riotInfoContentEl.classList.add('is-loading');
    // If the AI is slow (usually Google being overloaded and us retrying),
    // say so instead of sitting on the same line for 15 seconds.
    const openedRiotId = riot.id;
    const stillLoading = () =>
      currentRiotId === openedRiotId && riotInfoContentEl.classList.contains('is-loading');
    setTimeout(() => {
      if (stillLoading()) riotInfoContentEl.textContent = 'Still working on it. The AI is a bit busy, so this may take a few more seconds...';
    }, 4000);
    setTimeout(() => {
      if (stillLoading()) riotInfoContentEl.textContent = 'Almost there. Google\'s AI is really busy right now, hang tight...';
    }, 10000);
    riotSourcesEl.innerHTML = '';

    // Open the modal via class toggle (not inline styles) and lock body
    // scroll so the page behind the modal doesn't scroll.
    riotModal.classList.add('is-open');
    riotModal.classList.remove('hidden');
    document.body.classList.add('body-scroll-locked');

    // Move focus into the modal once it's actually visible. The close
    // button is a reliable, always-present first stop.
    requestAnimationFrame(() => {
      riotModalCloseBtn.focus();
    });

    // Kick off the enrich fetch right after the loading state is shown.
    fetchRiotEnrichment(riot);
  }

  function closeRiotModal() {
    // Cancel any in-flight enrich (Gemini) fetch for the riot being closed.
    if (currentEnrichAbortController) {
      currentEnrichAbortController.abort();
      currentEnrichAbortController = null;
    }

    // Clear "currently open riot" state.
    currentRiotId = null;
    currentRiot = null;
    currentRiotEnrichment = null;

    // Close the modal via class toggle and unlock body scroll.
    riotModal.classList.remove('is-open');
    riotModal.classList.add('hidden');
    document.body.classList.remove('body-scroll-locked');

    // Clear content back to empty so a freshly opened riot doesn't
    // briefly flash this riot's stale content before it's repopulated.
    riotTitleEl.textContent = '';
    riotDetailsIconEl.className = 'riot-window-icon';
    riotDetailsIconEl.style.background = '';
    riotDetailsSubtitleEl.textContent = '';
    riotInfoContentEl.textContent = '';
    riotInfoContentEl.classList.remove('is-loading');
    riotSourcesEl.innerHTML = '';

    // Clear any chat messages currently shown, and reset chat history, so
    // a freshly opened riot starts with a blank conversation.
    currentChatHistory = [];
    chatMessagesEl.innerHTML = '';
    hideChatInputWarning();

    // Return focus to whatever opened the modal (e.g. a riot-list
    // button), so keyboard/screen-reader users land back where they
    // were rather than at the top of the page.
    if (lastFocusedElementBeforeModal && typeof lastFocusedElementBeforeModal.focus === 'function') {
      lastFocusedElementBeforeModal.focus();
    }
    lastFocusedElementBeforeModal = null;
  }

  // Close via either window's close button.
  riotModalCloseBtn.addEventListener('click', closeRiotModal);
  riotChatCloseBtn.addEventListener('click', closeRiotModal);

  // Close via backdrop click — but not when the click originates from
  // inside the content card (that listener is on the backdrop element
  // itself, which sits behind the card, so clicks on the card never
  // reach it).
  riotModalBackdrop.addEventListener('click', closeRiotModal);

  // While the modal is open: Escape closes it, and Tab is trapped so
  // focus cycles within the modal instead of escaping to the page
  // behind it.
  document.addEventListener('keydown', (event) => {
    if (!riotModal.classList.contains('is-open')) return;

    if (event.key === 'Escape') {
      closeRiotModal();
      return;
    }

    if (event.key === 'Tab') {
      const focusable = getFocusableModalElements();
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });

  // Shared visual identity for "a riot happened here" — used for both
  // the map markers and the list's icon chips, so the two stay visually
  // tied together. A flame nods at the pyrotechnics/fires that show up
  // repeatedly in the riot data, without being cartoonish.
  const RIOT_ICON_SVG =
    '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 2C12 2 6.5 8.5 6.5 13C6.5 16.5 9 19.5 12.5 19.5C16 19.5 18.5 16.5 18.5 13.2C18.5 10.8 17 9 15.7 7.7C16 9.7 14.8 10.8 13.7 10.3C14.7 7.6 13.2 4.2 12 2Z" fill="currentColor"/></svg>';

  // Gradient stops for severity shading — kept in sync with the
  // --color-severity-* custom properties in style.css (duplicated here
  // since resolving nested var() references via getComputedStyle isn't
  // reliable across browsers).
  const SEVERITY_COLOR_LOW = '#146e64';
  const SEVERITY_COLOR_MID = '#8f620c';
  const SEVERITY_COLOR_HIGH = '#9c3a1f';

  function hexToRgb(hex) {
    const clean = hex.replace('#', '');
    return {
      r: parseInt(clean.substring(0, 2), 16),
      g: parseInt(clean.substring(2, 4), 16),
      b: parseInt(clean.substring(4, 6), 16),
    };
  }

  function lerpColor(hexA, hexB, t) {
    const a = hexToRgb(hexA);
    const b = hexToRgb(hexB);
    const r = Math.round(a.r + (b.r - a.r) * t);
    const g = Math.round(a.g + (b.g - a.g) * t);
    const bl = Math.round(a.b + (b.b - a.b) * t);
    return `rgb(${r}, ${g}, ${bl})`;
  }

  // Maps a 1–5 severity rating to a continuous color along a
  // teal -> gold -> red gradient, rather than three discrete buckets —
  // so map markers and list/badge icons shade smoothly by intensity
  // instead of jumping between three fixed colors. Returns null for
  // riots with no numeric severity, so callers can fall back to the
  // element's default (non-severity) styling.
  function getSeverityColor(severity) {
    const n = Number(severity);
    if (!Number.isFinite(n) || n <= 0) return null;
    const clamped = Math.max(1, Math.min(5, n));
    if (clamped <= 3) {
      return lerpColor(SEVERITY_COLOR_LOW, SEVERITY_COLOR_MID, (clamped - 1) / 2);
    }
    return lerpColor(SEVERITY_COLOR_MID, SEVERITY_COLOR_HIGH, (clamped - 3) / 2);
  }

  // Builds a small dot-based severity indicator (n of 5 filled), with a
  // visually-hidden text equivalent since the dots themselves are
  // decorative (aria-hidden).
  function buildSeverityIndicator(severity) {
    const n = Number(severity);
    if (!Number.isFinite(n) || n <= 0) return null;
    const level = Math.max(1, Math.min(5, Math.round(n)));

    const wrap = document.createElement('span');
    wrap.className = 'riot-list-severity';

    const dots = document.createElement('span');
    dots.setAttribute('aria-hidden', 'true');
    dots.style.display = 'contents';
    for (let i = 1; i <= 5; i++) {
      const dot = document.createElement('span');
      dot.className = 'riot-severity-dot' + (i <= level ? ' is-filled' : '');
      dots.appendChild(dot);
    }
    wrap.appendChild(dots);

    const hiddenLabel = document.createElement('span');
    hiddenLabel.className = 'visually-hidden';
    hiddenLabel.textContent = `Severity ${level} of 5`;
    wrap.appendChild(hiddenLabel);

    return wrap;
  }

  // Formats an ISO date string (e.g. "2024-03-16") into a short,
  // readable form. Falls back to the raw string if it doesn't parse.
  function formatRiotDate(dateStr) {
    if (!dateStr || typeof dateStr !== 'string') return '';
    const parsed = new Date(`${dateStr}T00:00:00`);
    if (Number.isNaN(parsed.getTime())) return dateStr;
    return parsed.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }

  // Builds the "City, Country · Date" meta line for a list card, from
  // whichever of those fields are actually present.
  function buildRiotListMeta(riot) {
    const parts = [];

    const place = [riot.city, riot.country].filter(Boolean).join(', ');
    if (place) parts.push(place);

    const formattedDate = formatRiotDate(riot.date);
    if (formattedDate) parts.push(formattedDate);

    return parts.join(' · ');
  }

  // Custom Leaflet marker icon — a colored teardrop badge with the
  // shared riot glyph, replacing Leaflet's default blue pin. Color
  // shades continuously by riotSeverity via getSeverityColor above.
  function buildRiotMarkerIcon(riot) {
    const color = getSeverityColor(riot.riotSeverity);
    const styleAttr = color ? ` style="background: ${color};"` : '';
    return L.divIcon({
      className: 'riot-marker-icon',
      html: `<span class="riot-marker-badge"${styleAttr}>${RIOT_ICON_SVG}</span>`,
      iconSize: [30, 38],
      iconAnchor: [15, 38],
      popupAnchor: [0, -34],
    });
  }


  const map = L.map('map-container', {
    center: [20, 0],
    zoom: 2,
    minZoom: 2,
    maxZoom: 18,
    maxBounds: worldBounds,
    maxBoundsViscosity: 1.0, // fully resist dragging past the bounds
  });

  // OpenStreetMap tile layer — attribution is required by OSM's usage
  // policy and must not be omitted.
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    minZoom: 2,
    maxZoom: 18,
    noWrap: true, // don't repeat the world map horizontally when zoomed out
    // noWrap alone still asks the server for tiles past the edge of the
    // world (x = -1, x = 4 at zoom 2), and OpenStreetMap answers those
    // with a 400. Limiting the layer to the world bounds stops the
    // requests, which is what was filling the console with errors.
    bounds: worldBounds,
  }).addTo(map);

  // #map-container's height changes at the mobile breakpoint (and on
  // orientation change), which can leave Leaflet's tiles rendered
  // incorrectly unless the map is told to re-measure its container.
  // Debounced so rapid resize events don't trigger this repeatedly.
  let resizeDebounceTimer = null;
  function handleViewportResize() {
    clearTimeout(resizeDebounceTimer);
    resizeDebounceTimer = setTimeout(() => {
      map.invalidateSize();
    }, 150);
  }

  window.addEventListener('resize', handleViewportResize);
  window.addEventListener('orientationchange', handleViewportResize);

  // ==========================================================================
  // Page router — this is a single HTML file with three client-side
  // "pages" (#map-section, #analyze-section, #contact-section). The nav
  // links toggle between them via the URL hash, rather than each one
  // linking to its own HTML file — only one page is ever visible at a time.
  // ==========================================================================
  const PAGES = {
    map: { el: document.getElementById('map-section'), navLink: document.getElementById('nav-link-map') },
    analyze: { el: document.getElementById('analyze-section'), navLink: document.getElementById('nav-link-analyze') },
    mitigation: { el: document.getElementById('mitigation-section'), navLink: document.getElementById('nav-link-mitigation') },
    data: { el: document.getElementById('data-section'), navLink: document.getElementById('nav-link-data') },
    contact: { el: document.getElementById('contact-section'), navLink: document.getElementById('nav-link-contact') },
  };

  function showPage(pageName) {
    const activeName = Object.prototype.hasOwnProperty.call(PAGES, pageName) ? pageName : 'map';

    Object.keys(PAGES).forEach((name) => {
      const isActive = name === activeName;
      const page = PAGES[name];
      page.el.classList.toggle('is-active', isActive);
      page.el.setAttribute('aria-hidden', String(!isActive));
      if (isActive) {
        page.navLink.setAttribute('aria-current', 'page');
      } else {
        page.navLink.removeAttribute('aria-current');
      }
    });

    if (activeName === 'map') {
      // Leaflet miscalculates tile sizing while its container was
      // display: none, so it needs to re-measure now that it's visible
      // again. requestAnimationFrame ensures the container has actually
      // been unhidden by the class toggle above before Leaflet measures it.
      requestAnimationFrame(() => map.invalidateSize());
    }

    // Don't leave a request running for a page the user has navigated
    // away from.
    if (activeName !== 'analyze' && currentAnalyzeAbortController) {
      currentAnalyzeAbortController.abort();
      currentAnalyzeAbortController = null;
    }

    // Don't leave the riot popup open behind whichever page is now hidden.
    if (riotModal.classList.contains('is-open')) {
      closeRiotModal();
    }
  }

  function syncPageFromHash() {
    showPage(window.location.hash.replace('#', ''));
  }

  Object.keys(PAGES).forEach((name) => {
    PAGES[name].navLink.addEventListener('click', (event) => {
      event.preventDefault();
      window.location.hash = name;
    });
  });

  window.addEventListener('hashchange', syncPageFromHash);
  syncPageFromHash();

  // ==========================================================================
  // Analyze Match — questionnaire-driven riot risk estimate
  // ==========================================================================
  const analyzeFormEl = document.getElementById('analyze-form');
  const analyzeSportEl = document.getElementById('analyze-sport');
  const analyzeCompetitionEl = document.getElementById('analyze-competition');
  const analyzeHomeTeamEl = document.getElementById('analyze-home-team');
  const analyzeAwayTeamEl = document.getElementById('analyze-away-team');
  const analyzeLocationEl = document.getElementById('analyze-location');
  const analyzeStadiumEl = document.getElementById('analyze-stadium');
  const analyzeImportanceEl = document.getElementById('analyze-importance');
  const analyzeRivalryEl = document.getElementById('analyze-rivalry');
  const analyzeRiskOrganizedEl = document.getElementById('analyze-risk-organized');
  const analyzeRiskAlcoholEl = document.getElementById('analyze-risk-alcohol');
  const analyzeRiskHistoryEl = document.getElementById('analyze-risk-history');
  const analyzeRiskTensionEl = document.getElementById('analyze-risk-tension');
  const analyzeRiskStakesEl = document.getElementById('analyze-risk-stakes');
  const analyzeRiskCapacityEl = document.getElementById('analyze-risk-capacity');
  const analyzeContextEl = document.getElementById('analyze-context');
  const analyzeFormWarningEl = document.getElementById('analyze-form-warning');
  const analyzeSubmitBtn = document.getElementById('analyze-submit');
  const analyzeResultEl = document.getElementById('analyze-result');

  function showAnalyzeFormWarning(text) {
    analyzeFormWarningEl.textContent = text;
    analyzeFormWarningEl.hidden = false;
  }

  function hideAnalyzeFormWarning() {
    analyzeFormWarningEl.hidden = true;
  }

  // Clear the warning as soon as the user edits any required field.
  [analyzeCompetitionEl, analyzeHomeTeamEl, analyzeAwayTeamEl, analyzeLocationEl].forEach((el) => {
    el.addEventListener('input', hideAnalyzeFormWarning);
  });

  // Builds the prediction prompt. Explicitly steers Gemini toward
  // reasoning from the stated factors and documented precedent rather
  // than generalizing about any nationality, region, or fan culture —
  // this is a real, if unusual, risk for a "predict a riot" prompt.
  //
  // No longer references the site's own riots.json dataset at all —
  // earlier versions passed it in as "reference" context, which forced
  // Gemini to invent nonsensical cross-sport comparisons for matchups
  // (e.g. American football) with zero relevant entries in that
  // dataset. This version reasons entirely from the submitted match
  // details and Gemini's own training knowledge of the actual teams
  // and venue involved.
  //
  // No Google Search grounding here — it requires a Cloud Billing
  // account linked to the project (a separate quota from plain text
  // generation, see the 429 troubleshooting earlier). Without it,
  // Gemini cannot pull real live numbers for a hypothetical match — the
  // prompt is written to push hard for depth and specificity from
  // training knowledge instead, while still refusing to invent facts.
  function buildAnalyzePrompt(formData) {
    return `You are a sports-event safety analyst estimating the likelihood of crowd violence ("a riot") at an upcoming or hypothetical match, for an educational data-science project.

Your analysis must be built entirely around the SPECIFIC match described below — these exact teams, this exact venue/city, and the exact factors provided. Do not give generic, surface-level, or boilerplate analysis that could apply to any match — go as deep and specific as you can, drawing on anything you genuinely know about these exact teams, their rivalry history (or lack of one), and this exact venue or the home team's city.

Match details:
${JSON.stringify(formData, null, 2)}

How to reason:
1. Draw on anything you genuinely know from training about these specific teams, their rivalry, this specific venue, the home team's city, and any real documented history of crowd incidents involving them — including specifics like notable past incidents, known fan culture, or stadium safety history if you are confident of them. If you do not know of any specific incidents involving these teams/venue, say so plainly rather than inventing one.
2. Weigh the specific factors provided in the match details above — the stated risk factors, match importance, rivalry level, and any additional/intangible context given.
3. Identify EVERY relevant risk factor you can for this specific match, not just the six the user checked on the form — the user's checklist is a starting point, not the full picture. Think broadly: venue-specific factors (layout, capacity pressure, transit access), regional/contextual factors, timing factors, anything genuinely relevant to this exact matchup. Rate each one you identify on its own severity.

IMPORTANT: do NOT reason from generalizations about any nationality, ethnicity, region, or fan culture being inherently "violent" — root every claim in stated risk factors or specific, real documented incidents, never in stereotypes about a country or people. You do NOT have live internet access for this request — do not claim to have looked anything up, and do not invent specific facts, incidents, or numbers you are not genuinely confident are real.

Every field below except "reasoning" must be SHORT, SCANNABLE fragments (a phrase or one sentence each) — this feeds a visual dashboard of charts and lists, not a written report. "reasoning" is the one place a fuller paragraph belongs.

Scoring guide. Use the whole 1-5 range and let the scores differ from each other, because a dashboard where every bar is 5/5 tells the reader nothing:
- 1 = negligible: no meaningful history or exposure on this dimension.
- 2 = low: minor or occasional issues only.
- 3 = moderate: real but ordinary for a competitive match of this kind.
- 4 = high: clear, documented problems or strong aggravating conditions.
- 5 = extreme: reserved for the worst cases on record, such as matches with a long history of deadly or large-scale violence. Most matches should have at most one or two 5s, and most should have none.
A routine regular-season game with low rivalry, no flagged risk factors and a well-run venue should land around 1 to 2 overall. Each riskProfile value and each identifiedRiskFactors severity is judged on its own, so a high-stakes game can still have low venueSecurityRisk. Include low-severity factors (1 or 2) when they are real, not only the alarming ones.

It is completely normal and expected for many matches — especially in sports or leagues with little documented history of crowd violence — to come back as low likelihood with few identified risk factors. Do not inflate the estimate or manufacture factors to seem more thorough.

Respond with ONLY a single JSON object (no markdown code fences, no commentary before or after it), with exactly this shape:
{
  "riotLikelihood": "Low" | "Medium" | "High" | "Very High",
  "likelihoodScore": <integer 1-5>,
  "predictedSeverity": <integer 1-5, your best estimate of severity if a riot were to occur>,
  "reasoning": "The one paragraph in this response — connects the specific submitted details to the likelihood estimate.",
  "riskProfile": {
    "rivalryIntensity": <integer 1-5>,
    "stakesPressure": <integer 1-5, based on match importance/stakes>,
    "crowdVolatility": <integer 1-5, based on stated risk factors like alcohol, organized groups, tension>,
    "venueSecurityRisk": <integer 1-5, based on venue/capacity factors>
  },
  "identifiedRiskFactors": [
    {"factor": "short label, a few words", "severity": <integer 1-5>}
  ],
  "historicalDataPoints": ["short factual bullet about real documented history for these teams/venue, a sentence or less each — omit this array or leave it empty if you don't know of any genuine ones, do not force one"],
  "mitigationFactors": ["short, specific, actionable recommendation tied to the actual teams/venue/risk factors, a sentence or less each"],
  "intangibleFactors": ["short bullet on a notable non-quantifiable factor, drawing only on the additional context actually provided — omit this array or leave it empty if none was given"]
}`;
  }

  // Maps a qualitative likelihood label to the same 1-5 severity color
  // gradient used elsewhere, via its numeric score.
  function getLikelihoodColor(likelihoodScore) {
    return getSeverityColor(likelihoodScore);
  }

  function renderAnalyzeError(message) {
    analyzeResultEl.hidden = false;
    analyzeResultEl.innerHTML = '';
    const statusEl = document.createElement('div');
    statusEl.className = 'analyze-result-status';
    const errorEl = document.createElement('p');
    errorEl.className = 'analyze-result-error';
    errorEl.textContent = message;
    statusEl.appendChild(errorEl);
    analyzeResultEl.appendChild(statusEl);
  }

  function renderAnalyzeLoading() {
    analyzeResultEl.hidden = false;
    analyzeResultEl.innerHTML = '';
    const statusEl = document.createElement('div');
    statusEl.className = 'analyze-result-status';
    const loadingEl = document.createElement('p');
    loadingEl.className = 'analyze-loading-text';
    loadingEl.setAttribute('role', 'status');
    loadingEl.setAttribute('aria-live', 'polite');
    loadingEl.textContent = 'Analyzing match factors...';
    setTimeout(() => {
      if (loadingEl.isConnected) loadingEl.textContent = 'Still working on it. The AI is a bit busy, so this can take a little longer...';
    }, 5000);
    setTimeout(() => {
      if (loadingEl.isConnected) loadingEl.textContent = 'Almost there. Google\'s AI is really busy right now, hang tight...';
    }, 12000);
    statusEl.appendChild(loadingEl);
    analyzeResultEl.appendChild(statusEl);
  }

  // Small icons for the stat-card row, reusing existing glyphs where a
  // good fit already exists (the flame for severity, the chat error
  // triangle for likelihood) and adding two new simple ones.
  const ANALYZE_STAT_ICONS = {
    likelihood: CHAT_AVATAR_ICONS.error,
    severity: RIOT_ICON_SVG,
    risk:
      '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 3L19 6V11C19 15.5 16 19 12 21C8 19 5 15.5 5 11V6L12 3Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
    profile:
      '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="4" y="3" width="16" height="18" rx="2" stroke="currentColor" stroke-width="2"/><path d="M8 8h8M8 12h8M8 16h5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    history:
      '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/><path d="M12 7v5l3.5 2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    mitigation:
      '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 3L19 6V11C19 15.5 16 19 12 21C8 19 5 15.5 5 11V6L12 3Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M9 12l2 2 4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    intangible: RIOT_ICON_SVG,
  };

  const CHECK_ICON_SVG =
    '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5 13l4 4L19 7" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const DASH_ICON_SVG =
    '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5 12h14" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>';

  // The six risk-factor checkboxes, read live from the form — used both
  // when building the submitted formData and when rendering the
  // dashboard's checklist/count, so there's one definition of what
  // "the six factors" are.
  function getRiskFactorChecklist() {
    return [
      { checked: analyzeRiskOrganizedEl.checked, label: 'Organized/ultras fan groups present' },
      { checked: analyzeRiskAlcoholEl.checked, label: 'Alcohol sold at the venue' },
      { checked: analyzeRiskHistoryEl.checked, label: 'History of incidents between these teams' },
      { checked: analyzeRiskTensionEl.checked, label: 'Elevated political or social tension' },
      { checked: analyzeRiskStakesEl.checked, label: 'Elimination / must-win stakes' },
      { checked: analyzeRiskCapacityEl.checked, label: 'Stadium expected to be near or over capacity' },
    ];
  }

  function createAnalyzeModule(extraClasses) {
    const el = document.createElement('div');
    el.className = ['analyze-module', ...(extraClasses || [])].join(' ');
    return el;
  }

  // Small stat card: icon, label, and a single content node (a number,
  // a badge, or a small group of badges — whatever the caller builds).
  function buildStatModule(iconSvg, label, contentNode) {
    const module = createAnalyzeModule();

    const icon = document.createElement('div');
    icon.className = 'analyze-stat-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = iconSvg;
    module.appendChild(icon);

    const labelEl = document.createElement('p');
    labelEl.className = 'analyze-stat-label';
    labelEl.textContent = label;
    module.appendChild(labelEl);

    module.appendChild(contentNode);
    return module;
  }

  // Circular gauge (SVG, stroke-dasharray technique) showing a 1-5
  // score, colored via the same severity gradient as the map/list.
  function buildGaugeSvg(score, max, color) {
    const radius = 40;
    const circumference = 2 * Math.PI * radius;
    const clampedScore = Math.max(0, Math.min(max, Number(score) || 0));
    const pct = max > 0 ? clampedScore / max : 0;
    const dash = circumference * pct;
    return `<svg viewBox="0 0 100 100" class="analyze-gauge-svg" aria-hidden="true">
      <circle class="analyze-gauge-track" cx="50" cy="50" r="${radius}"></circle>
      <circle class="analyze-gauge-value" cx="50" cy="50" r="${radius}" stroke="${color}"
        stroke-dasharray="${dash.toFixed(2)} ${circumference.toFixed(2)}"
        transform="rotate(-90 50 50)"></circle>
    </svg>`;
  }

  function buildGaugeModule(title, score, max, caption) {
    const module = createAnalyzeModule(['analyze-module--span-2']);

    const titleEl = document.createElement('p');
    titleEl.className = 'analyze-module-title';
    titleEl.textContent = title;
    module.appendChild(titleEl);

    const wrap = document.createElement('div');
    wrap.className = 'analyze-gauge-wrap';

    const color = getSeverityColor(score) || 'var(--color-accent)';
    const svgHost = document.createElement('div');
    svgHost.innerHTML = buildGaugeSvg(score, max, color);
    wrap.appendChild(svgHost.firstElementChild);

    const textWrap = document.createElement('div');
    const numberEl = document.createElement('div');
    numberEl.className = 'analyze-gauge-number';
    const numericScore = Number(score);
    numberEl.textContent = Number.isFinite(numericScore) ? `${numericScore}/${max}` : '—';
    const captionEl = document.createElement('div');
    captionEl.className = 'analyze-gauge-caption';
    captionEl.textContent = caption || '';
    textWrap.appendChild(numberEl);
    textWrap.appendChild(captionEl);
    wrap.appendChild(textWrap);

    module.appendChild(wrap);
    return module;
  }

  function buildRiskChecklistModule() {
    const module = createAnalyzeModule(['analyze-module--span-2', 'analyze-module--tone-violet']);

    const titleEl = document.createElement('p');
    titleEl.className = 'analyze-module-title';
    titleEl.textContent = 'Your Flagged Factors';
    module.appendChild(titleEl);

    const list = document.createElement('div');
    list.className = 'analyze-checklist';
    getRiskFactorChecklist().forEach((factor) => {
      const item = document.createElement('div');
      item.className = 'analyze-checklist-item' + (factor.checked ? ' is-present' : '');

      const icon = document.createElement('span');
      icon.className = 'analyze-checklist-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.innerHTML = factor.checked ? CHECK_ICON_SVG : DASH_ICON_SVG;

      const text = document.createElement('span');
      text.textContent = factor.label;

      item.appendChild(icon);
      item.appendChild(text);
      list.appendChild(item);
    });
    module.appendChild(list);
    return module;
  }

  // Recap of what was actually submitted — supports the "customized to
  // every matchup" goal by making it visible at a glance which details
  // this specific dashboard is for.
  function buildMatchDetailsModule(formData) {
    const module = createAnalyzeModule(['analyze-module--span-2']);

    const titleEl = document.createElement('p');
    titleEl.className = 'analyze-module-title';
    titleEl.textContent = 'Match Details';
    module.appendChild(titleEl);

    const list = document.createElement('dl');
    list.className = 'analyze-details-list';
    [
      ['Sport', formData.sport],
      ['Competition', formData.competition],
      ['Venue', formData.stadium || 'Not specified'],
      ['Location', formData.location],
    ].forEach(([label, value]) => {
      if (!value) return;
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = value;
      list.appendChild(dt);
      list.appendChild(dd);
    });
    module.appendChild(list);
    return module;
  }

  // The ONLY module that renders a paragraph — used exclusively for
  // "reasoning". Everything else on the dashboard is short, scannable
  // fragments in a list or chart, per the "graphics, not prose" design.
  function buildTextModule(title, text, spanFull) {
    if (!text) return null;
    const module = createAnalyzeModule([spanFull ? 'analyze-module--span-4' : 'analyze-module--span-2']);
    const titleEl = document.createElement('p');
    titleEl.className = 'analyze-module-title';
    titleEl.textContent = title;
    const bodyEl = document.createElement('p');
    bodyEl.className = 'analyze-module-body';
    bodyEl.textContent = text;
    module.appendChild(titleEl);
    module.appendChild(bodyEl);
    return module;
  }

  // Icon-prefixed row list (historical data points / mitigation /
  // intangible factors) — scannable rows instead of plain bullet text,
  // reusing the same visual language as the risk-factor checklist.
  function buildIconListModule(title, items, iconSvg, spanFull, toneClass) {
    if (!Array.isArray(items)) return null;
    const validItems = items.filter((item) => typeof item === 'string' && item);
    if (validItems.length === 0) return null;

    const classes = [spanFull ? 'analyze-module--span-4' : 'analyze-module--span-2'];
    if (toneClass) classes.push(toneClass);
    const module = createAnalyzeModule(classes);
    const titleEl = document.createElement('p');
    titleEl.className = 'analyze-module-title';
    titleEl.textContent = title;
    module.appendChild(titleEl);

    const list = document.createElement('div');
    list.className = 'analyze-icon-list';
    validItems.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'analyze-icon-list-item';

      const icon = document.createElement('span');
      icon.className = 'analyze-icon-list-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.innerHTML = iconSvg;

      const textEl = document.createElement('span');
      textEl.textContent = item;

      row.appendChild(icon);
      row.appendChild(textEl);
      list.appendChild(row);
    });
    module.appendChild(list);
    return module;
  }

  // A single labeled bar-chart row (label, filled track, numeric value)
  // — the shared building block for the risk-profile and
  // identified-risk-factors charts below. Colored via the same
  // teal→gold→red severity gradient used across the site.
  function buildBarChartRow(label, score, max) {
    const row = document.createElement('div');
    row.className = 'analyze-bar-row';

    const labelEl = document.createElement('span');
    labelEl.className = 'analyze-bar-label';
    labelEl.textContent = label;
    labelEl.title = label;

    const trackEl = document.createElement('div');
    trackEl.className = 'analyze-bar-track';
    const fillEl = document.createElement('div');
    fillEl.className = 'analyze-bar-fill';
    const clampedScore = Math.max(0, Math.min(max, Number(score) || 0));
    const pct = max > 0 ? (clampedScore / max) * 100 : 0;
    fillEl.style.width = `${pct}%`;
    fillEl.style.background = getSeverityColor(clampedScore) || 'var(--color-accent)';
    trackEl.appendChild(fillEl);

    const valueEl = document.createElement('span');
    valueEl.className = 'analyze-bar-value';
    valueEl.textContent = `${clampedScore}/${max}`;

    row.appendChild(labelEl);
    row.appendChild(trackEl);
    row.appendChild(valueEl);
    return row;
  }

  // Four-dimension bar chart (rivalry intensity, stakes pressure, crowd
  // volatility, venue security risk) — a second, more granular graph
  // alongside the single overall likelihood gauge.
  function buildRiskProfileModule(riskProfile) {
    if (!riskProfile || typeof riskProfile !== 'object') return null;

    const dimensions = [
      ['Rivalry Intensity', riskProfile.rivalryIntensity],
      ['Stakes Pressure', riskProfile.stakesPressure],
      ['Crowd Volatility', riskProfile.crowdVolatility],
      ['Venue Security Risk', riskProfile.venueSecurityRisk],
    ].filter(([, score]) => Number.isFinite(Number(score)));

    if (dimensions.length === 0) return null;

    const module = createAnalyzeModule(['analyze-module--span-2', 'analyze-module--tone-gold']);
    const titleEl = document.createElement('p');
    titleEl.className = 'analyze-module-title';
    titleEl.textContent = 'Risk Profile';
    module.appendChild(titleEl);

    const chart = document.createElement('div');
    chart.className = 'analyze-bar-chart';
    dimensions.forEach(([label, score]) => {
      chart.appendChild(buildBarChartRow(label, Number(score), 5));
    });
    module.appendChild(chart);
    return module;
  }

  // Open-ended bar chart of every risk factor Gemini actually
  // identified for this specific matchup — not capped at the 6
  // checkboxes from the form, which was giving the false impression
  // that only 6 factors exist. Full width since the list length varies.
  function buildIdentifiedRiskFactorsModule(factors) {
    if (!Array.isArray(factors)) return null;
    const valid = factors.filter(
      (f) => f && typeof f.factor === 'string' && f.factor && Number.isFinite(Number(f.severity))
    );
    if (valid.length === 0) return null;

    const module = createAnalyzeModule(['analyze-module--span-4']);
    const titleEl = document.createElement('p');
    titleEl.className = 'analyze-module-title';
    titleEl.textContent = `Identified Risk Factors (${valid.length})`;
    module.appendChild(titleEl);

    const chart = document.createElement('div');
    chart.className = 'analyze-bar-chart';
    valid.forEach((f) => {
      chart.appendChild(buildBarChartRow(f.factor, Number(f.severity), 5));
    });
    module.appendChild(chart);
    return module;
  }

  // Geocodes a free-text location via Nominatim, OpenStreetMap's free
  // geocoding service — no API key needed. A single lookup per analysis
  // like this is light, occasional use within Nominatim's usage policy;
  // this pattern isn't suitable for high-volume/bulk geocoding.
  function geocodeLocation(query) {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
    return fetch(url)
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Geocoding request failed: ${response.status}`);
        }
        return response.json();
      })
      .then((results) => {
        if (!Array.isArray(results) || results.length === 0) return null;
        const first = results[0];
        const lat = parseFloat(first.lat);
        const lon = parseFloat(first.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
        return { lat, lon, displayName: first.display_name };
      });
  }

  // Holds the mini Leaflet map instance shown in the stadium-location
  // module, so a re-run of the analysis can clean up the previous one
  // before creating a new one (Leaflet errors if a container already
  // holding a map is re-initialized).
  let analyzeMapInstance = null;

  function buildStadiumMapModule(formData) {
    const module = createAnalyzeModule(['analyze-module--span-2', 'analyze-map-module', 'analyze-module--tone-teal']);

    const titleEl = document.createElement('p');
    titleEl.className = 'analyze-module-title';
    titleEl.textContent = 'Stadium Location';
    module.appendChild(titleEl);

    const statusEl = document.createElement('div');
    statusEl.className = 'analyze-map-status';
    statusEl.textContent = 'Locating...';
    module.appendChild(statusEl);

    // Prefer the stadium name (more precise) but fall back to the
    // general match location if no stadium was given.
    const query = formData.stadium ? `${formData.stadium}, ${formData.location}` : formData.location;

    geocodeLocation(query)
      .then((geo) => {
        if (!geo) {
          statusEl.textContent = `Couldn't locate "${query}" on the map.`;
          return;
        }

        statusEl.remove();

        const mapContainer = document.createElement('div');
        mapContainer.className = 'analyze-map-container';
        module.appendChild(mapContainer);

        const captionEl = document.createElement('p');
        captionEl.className = 'analyze-map-caption';
        captionEl.textContent = geo.displayName;
        module.appendChild(captionEl);

        if (analyzeMapInstance) {
          analyzeMapInstance.remove();
          analyzeMapInstance = null;
        }

        // Low zoom and interactions disabled — this is a small "where
        // in the world is this" context visual for a dashboard card,
        // not a primary interactive map.
        analyzeMapInstance = L.map(mapContainer, {
          center: [geo.lat, geo.lon],
          zoom: 4,
          zoomControl: false,
          dragging: false,
          scrollWheelZoom: false,
          doubleClickZoom: false,
          boxZoom: false,
          keyboard: false,
          touchZoom: false,
        });

        // OpenStreetMap tiles — attribution is required by OSM's usage
        // policy and must not be omitted, same as the main map.
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          attribution: '&copy; OpenStreetMap contributors',
          minZoom: 2,
          maxZoom: 18,
        }).addTo(analyzeMapInstance);

        L.marker([geo.lat, geo.lon], {
          icon: L.divIcon({
            className: 'riot-marker-icon',
            html: `<span class="riot-marker-badge">${RIOT_ICON_SVG}</span>`,
            iconSize: [24, 30],
            iconAnchor: [12, 30],
          }),
        }).addTo(analyzeMapInstance);

        // The container had zero size while not yet appended/painted —
        // re-measure now, same fix used for the main map after page
        // switches.
        requestAnimationFrame(() => {
          if (analyzeMapInstance) analyzeMapInstance.invalidateSize();
        });
      })
      .catch((error) => {
        console.error('Error geocoding stadium location:', error);
        statusEl.textContent = 'Location lookup failed.';
      });

    return module;
  }

  function renderAnalyzeResult(result, formData) {
    analyzeResultEl.hidden = false;
    analyzeResultEl.innerHTML = '';

    const dashboard = document.createElement('div');
    dashboard.className = 'analyze-dashboard';

    // Header — which matchup this dashboard is for, so it's obvious
    // this is customized per-analysis rather than a generic template.
    const header = document.createElement('div');
    header.className = 'analyze-dashboard-header';

    const titleEl = document.createElement('h3');
    titleEl.className = 'analyze-dashboard-title';
    titleEl.tabIndex = -1;
    titleEl.textContent = `${formData.homeTeam} vs ${formData.awayTeam}`;

    const subtitleEl = document.createElement('p');
    subtitleEl.className = 'analyze-dashboard-subtitle';
    subtitleEl.textContent = [formData.competition, formData.location].filter(Boolean).join(' · ');

    header.appendChild(titleEl);
    header.appendChild(subtitleEl);
    dashboard.appendChild(header);

    const grid = document.createElement('div');
    grid.className = 'analyze-grid';

    // --- Row 1: stat cards ---
    const likelihoodBadge = document.createElement('span');
    likelihoodBadge.className = 'analyze-badge';
    const likelihoodColor = getLikelihoodColor(result.likelihoodScore);
    if (likelihoodColor) {
      likelihoodBadge.style.background = likelihoodColor;
      likelihoodBadge.style.color = '#fff';
      likelihoodBadge.style.border = 'none';
    }
    likelihoodBadge.textContent = typeof result.riotLikelihood === 'string' ? result.riotLikelihood : 'Unknown';
    grid.appendChild(buildStatModule(ANALYZE_STAT_ICONS.likelihood, 'Riot Likelihood', likelihoodBadge));

    const severityWrap = document.createElement('div');
    const severityNumber = document.createElement('div');
    severityNumber.className = 'analyze-stat-value';
    const severityScore = Number(result.predictedSeverity);
    severityNumber.textContent = Number.isFinite(severityScore) ? `${severityScore}/5` : '—';
    severityWrap.appendChild(severityNumber);
    const severityDots = buildSeverityIndicator(result.predictedSeverity);
    if (severityDots) severityWrap.appendChild(severityDots);
    grid.appendChild(buildStatModule(ANALYZE_STAT_ICONS.severity, 'Predicted Severity', severityWrap));

    const riskChecklist = getRiskFactorChecklist();
    const riskCount = riskChecklist.filter((factor) => factor.checked).length;
    const riskValue = document.createElement('div');
    riskValue.className = 'analyze-stat-value';
    riskValue.textContent = `${riskCount}/${riskChecklist.length}`;
    grid.appendChild(buildStatModule(ANALYZE_STAT_ICONS.risk, 'Your Flagged Factors', riskValue));

    const profileWrap = document.createElement('div');
    profileWrap.className = 'analyze-stat-badges';
    const rivalryBadge = document.createElement('span');
    rivalryBadge.className = 'analyze-badge';
    rivalryBadge.textContent = `${formData.rivalryLevel} rivalry`;
    const importanceBadge = document.createElement('span');
    importanceBadge.className = 'analyze-badge';
    importanceBadge.textContent = formData.matchImportance;
    profileWrap.appendChild(rivalryBadge);
    profileWrap.appendChild(importanceBadge);
    grid.appendChild(buildStatModule(ANALYZE_STAT_ICONS.profile, 'Match Profile', profileWrap));

    // --- Row 2: likelihood gauge + risk profile bar chart ---
    grid.appendChild(
      buildGaugeModule(
        'Likelihood Gauge',
        result.likelihoodScore,
        5,
        typeof result.riotLikelihood === 'string' ? `${result.riotLikelihood} likelihood` : ''
      )
    );
    const riskProfileModule = buildRiskProfileModule(result.riskProfile);
    if (riskProfileModule) grid.appendChild(riskProfileModule);

    // --- Row 3: AI-identified risk factors — an open-ended bar chart,
    // not capped at the 6 checkboxes on the form, so the dashboard
    // doesn't imply those 6 are the only risk factors that exist. ---
    const identifiedFactorsModule = buildIdentifiedRiskFactorsModule(result.identifiedRiskFactors);
    if (identifiedFactorsModule) grid.appendChild(identifiedFactorsModule);

    // --- Row 4: stadium map + your flagged factors / match details ---
    grid.appendChild(buildStadiumMapModule(formData));
    grid.appendChild(buildRiskChecklistModule());
    grid.appendChild(buildMatchDetailsModule(formData));

    // --- Row 5: reasoning — the one paragraph on this dashboard ---
    const reasoningModule = buildTextModule('Reasoning', result.reasoning, true);
    if (reasoningModule) grid.appendChild(reasoningModule);

    // --- Row 6: historical data points / mitigation / intangible —
    // short scannable rows with icons, not paragraphs or plain bullets.
    const historicalModule = buildIconListModule(
      'Historical Data Points',
      result.historicalDataPoints,
      ANALYZE_STAT_ICONS.history,
      true,
      'analyze-module--tone-teal'
    );
    if (historicalModule) grid.appendChild(historicalModule);

    const mitigationModule = buildIconListModule(
      'Mitigation Factors',
      result.mitigationFactors,
      ANALYZE_STAT_ICONS.mitigation,
      false,
      'analyze-module--tone-gold'
    );
    if (mitigationModule) grid.appendChild(mitigationModule);

    const intangibleModule = buildIconListModule(
      'Intangible Factors',
      result.intangibleFactors,
      ANALYZE_STAT_ICONS.intangible,
      false,
      'analyze-module--tone-violet'
    );
    if (intangibleModule) grid.appendChild(intangibleModule);

    dashboard.appendChild(grid);
    analyzeResultEl.appendChild(dashboard);

    // Move focus to the dashboard heading so keyboard/screen-reader
    // users land on it immediately rather than having to find it
    // themselves.
    titleEl.focus();
  }

  function runMatchAnalysis(formData) {
    const controller = new AbortController();
    currentAnalyzeAbortController = controller;

    geminiFetch(
      GEMINI_ANALYZE_API_KEY,
      { contents: [{ parts: [{ text: buildAnalyzePrompt(formData) }] }] },
      controller.signal
    )
      .then((response) => {
        if (!response.ok) {
          return response.text().then((bodyText) => {
            console.error(`Gemini analyze request failed: ${response.status} ${response.statusText}`, bodyText);
            const requestError = new Error(`Gemini analyze request failed: ${response.status} ${response.statusText}`);
            requestError.status = response.status;
            throw requestError;
          });
        }
        return response.json();
      })
      .then((geminiData) => {
        const candidate = geminiData && geminiData.candidates && geminiData.candidates[0];
        const parts = candidate && candidate.content && candidate.content.parts;
        const rawText = Array.isArray(parts) ? parts.map((part) => part.text || '').join('') : '';
        const structured = tryParseGeminiStructuredResponse(rawText);

        if (structured) {
          renderAnalyzeResult(structured, formData);
        } else {
          renderAnalyzeError('The AI response could not be parsed. Please try again.');
        }
      })
      .catch((error) => {
        // An aborted request just means the user left the page — not an
        // error, so don't show one for it.
        if (error.name === 'AbortError') return;

        console.error('Error running match analysis:', error);
        renderAnalyzeError(
          geminiErrorMessage(error, 'Something went wrong analyzing this match. Please try again.')
        );
      })
      .finally(() => {
        analyzeSubmitBtn.disabled = false;
        analyzeSubmitBtn.textContent = 'Analyze Match';
      });
  }

  analyzeFormEl.addEventListener('submit', (event) => {
    event.preventDefault();

    const homeTeam = analyzeHomeTeamEl.value.trim();
    const awayTeam = analyzeAwayTeamEl.value.trim();
    const competition = analyzeCompetitionEl.value.trim();
    const location = analyzeLocationEl.value.trim();

    if (!homeTeam || !awayTeam || !competition || !location) {
      showAnalyzeFormWarning('Please fill in the competition, both teams, and the match location.');
      return;
    }

    hideAnalyzeFormWarning();

    const riskFactors = getRiskFactorChecklist()
      .filter((factor) => factor.checked)
      .map((factor) => factor.label);

    const formData = {
      sport: analyzeSportEl.value,
      competition,
      homeTeam,
      awayTeam,
      location,
      stadium: analyzeStadiumEl.value.trim() || null,
      matchImportance: analyzeImportanceEl.value,
      rivalryLevel: analyzeRivalryEl.value,
      knownRiskFactors: riskFactors,
      additionalContext: analyzeContextEl.value.trim() || null,
    };

    analyzeSubmitBtn.disabled = true;
    analyzeSubmitBtn.textContent = 'Analyzing...';
    renderAnalyzeLoading();
    runMatchAnalysis(formData);
  });

  // Fetch riot data and add a marker for each entry.
  fetch('data/riots.json')
    .then((response) => {
      if (!response.ok) {
        throw new Error(`Failed to fetch riots.json: ${response.status} ${response.statusText}`);
      }
      return response.json();
    })
    .then((riots) => {
      riotListEl.innerHTML = '';

      riots.forEach((riot) => {
        if (typeof riot.lat !== 'number' || typeof riot.lng !== 'number') {
          console.error('Skipping riot entry with invalid lat/lng:', riot);
          return;
        }

        riotsById[riot.id] = riot;

        const marker = L.marker([riot.lat, riot.lng], {
          icon: buildRiotMarkerIcon(riot),
        }).addTo(map);

        // Only the `title` field is relied on here — other field names
        // are still placeholders and may change.
        marker.bindTooltip(riot.title);

        // Store the riot's id on the marker so the full riot object can
        // be looked up later (e.g. when wiring up the modal).
        marker.riotId = riot.id;

        marker.on('click', () => {
          const riotData = riotsById[marker.riotId];
          if (!riotData) {
            console.error('No riot data found for id:', marker.riotId);
            return;
          }
          openRiotModal(riotData);
        });

        // Accessible, real <button> alternative to clicking the marker —
        // fully keyboard-operable and announced normally by screen
        // readers, unlike the Leaflet marker itself. Built as a small
        // card: icon chip, title, a location/date meta line where that
        // data is available, and a severity indicator.
        const listItem = document.createElement('li');
        const listButton = document.createElement('button');
        listButton.type = 'button';
        listButton.className = 'riot-list-item';

        const iconChip = document.createElement('span');
        iconChip.className = 'riot-list-icon';
        const iconColor = getSeverityColor(riot.riotSeverity);
        if (iconColor) iconChip.style.background = iconColor;
        iconChip.setAttribute('aria-hidden', 'true');
        iconChip.innerHTML = RIOT_ICON_SVG;
        listButton.appendChild(iconChip);

        const textWrap = document.createElement('span');
        textWrap.className = 'riot-list-text';

        const titleEl = document.createElement('span');
        titleEl.className = 'riot-list-title';
        titleEl.textContent = riot.title;
        textWrap.appendChild(titleEl);

        const metaText = buildRiotListMeta(riot);
        if (metaText) {
          const metaEl = document.createElement('span');
          metaEl.className = 'riot-list-meta';
          metaEl.textContent = metaText;
          textWrap.appendChild(metaEl);
        }

        listButton.appendChild(textWrap);

        const severityEl = buildSeverityIndicator(riot.riotSeverity);
        if (severityEl) {
          listButton.appendChild(severityEl);
        }

        listButton.addEventListener('click', () => openRiotModal(riot));
        listItem.appendChild(listButton);
        riotListEl.appendChild(listItem);
      });

      // Markers (and the list) are in place — the loading indicator's
      // job is done.
      mapLoadingEl.hidden = true;
    })
    .catch((error) => {
      // Fetch failing (missing file, bad JSON, network error, etc.)
      // should not crash the map — just log it, and swap the loading
      // indicator for a clear inline error rather than leaving it
      // spinning forever.
      console.error('Error loading riot data:', error);
      mapLoadingEl.hidden = true;
      mapErrorEl.textContent =
        'Riot data could not be loaded. The map will not show any markers right now — please try reloading the page.';
      mapErrorEl.hidden = false;
    });
});
