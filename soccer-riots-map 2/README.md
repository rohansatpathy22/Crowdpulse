# CrowdPulse

**Live site: [crowd-pulse.netlify.app](https://crowd-pulse.netlify.app/)**

CrowdPulse is an interactive map of real, documented sports riots and crowd violence incidents from around the world, with AI-generated summaries, a chatbot for asking follow-up questions about each event, and a tool that estimates riot risk for a hypothetical matchup based on real historical patterns.

It started as a data-science project about mapping and understanding crowd violence at sporting events, and turned into a full single-page app: a world map with custom markers, an AI research/chat layer on top of a real dataset, a predictive risk dashboard, and a crowd-safety reference page.

## What it does

- **Interactive map.** 20 real, individually researched sports riots and stadium disasters, plotted across six continents and six sports (soccer, basketball, baseball, cricket, ice hockey, American football). Each marker is color-shaded on a continuous gradient by how severe the event was, not just a handful of fixed categories.
- **AI-generated summaries.** Click a marker (or use the accessible list below the map) and Gemini writes a summary, cause breakdown, and impact writeup for that specific event, built entirely from the event's own structured data rather than a canned paragraph.
- **Ask AI.** A chat panel next to the summary lets you ask follow-up questions about that specific riot, with the AI kept grounded in the same facts already shown on the page so it doesn't contradict itself.
- **Analyze Match.** Fill out a short questionnaire about a real or hypothetical matchup (teams, venue, competition, known risk factors) and Gemini generates a full risk dashboard: a likelihood gauge, a four-factor risk profile chart, an open-ended list of AI-identified risk factors (not capped at what you checked on the form), a geocoded mini-map of the stadium, and mitigation recommendations specific to that matchup.
- **Data Dashboard.** Upload an Excel file with 8 columns (date, sport, country, match type, attendance, injuries, arrests and severity) and it turns into stats, charts, filters and a sortable table. No AI is involved, and the file is read in the browser and never uploaded anywhere. There's a demo file you can download to try it.
- **Mitigation Factors.** A static reference page on general riot prevention and response, written to apply to any sport or venue, not tied to a specific incident.

## How it's built

Plain HTML, CSS, and JavaScript. No framework, no bundler, no build step.

- **Map:** [Leaflet.js](https://leafletjs.com/) with OpenStreetMap tiles. Custom marker icons instead of the Leaflet default pin, colored on a continuous severity gradient computed in JS.
- **AI:** Google's Gemini API, called directly from the browser. Two separate keys, one for riot summaries/chat, one for Analyze Match, so heavy testing of one never rate-limits the other.
- **Geocoding:** OpenStreetMap's free Nominatim service, used to place the Analyze Match stadium mini-map from whatever venue/city you type in.
- **Routing:** everything is one HTML file. Map, Analyze Match, Mitigation Factors, Data Dashboard, and Contact are all sections that get shown/hidden by JS based on the URL hash, so switching pages doesn't reload anything.
- **Spreadsheets:** [SheetJS](https://sheetjs.com/) reads the uploaded Excel file. It only gets downloaded the first time someone uploads a file. The Data Dashboard charts are hand-built SVG, so there's no chart library.
- **Fonts:** Space Grotesk for UI labels and Fraunces (a serif) for the bigger editorial headlines, like each riot's title.

## The dataset

`data/riots.json` holds 20 real events. I wasn't willing to just make up riot data or reuse a fictional test set for a real deployment, so every entry was individually researched and fact-checked, and any figure I couldn't verify from a real source got left out of that entry instead of estimated. A few disasters that get lumped in with "riots" in casual conversation (Hillsborough, for example) are deliberately excluded, since those were crowd-crush and safety failures, not actual crowd violence, and lumping them in would misrepresent what happened to the people who died.

## Design

The whole visual direction went through a few passes before landing where it is now, a dark, two-tone editorial look (a warm red-orange paired with a deep teal, plus gold and violet as secondary accents) instead of a single flat dark color everywhere. I pulled a lot of the layout and color ideas from browsing Dribbble, especially the idea of pairing a big serif display font with a smaller geometric sans for UI text, using bold solid-color chips instead of one repeated gradient for every icon, and giving cards real separation from the page background instead of everything blending into one flat surface. The Analyze Match results page is built as a bento-style dashboard of small modules (stat cards, gauges, bar charts) for the same reason, since a wall of AI-generated paragraphs is a lot harder to actually read than a few charts and a short list.

## Structure

```
/
  index.html              single page: map, Analyze Match, Mitigation Factors, About/Contact
  css/style.css
  js/script.js            map logic, page router, and all client-side Gemini API calls
  js/dashboard.js         Data Dashboard: Excel upload, validation, stats and charts (no AI)
  data/riots.json         20 real, researched sports riots/crowd violence events
  data/demo-incidents.xlsx  made-up sample file for trying the Data Dashboard
  netlify.toml            Netlify build config
  assets/                 profile photo goes here (assets/profile.jpg), screenshots/ has the README images
  netlify/functions/      currently unused (an earlier server-side version of the AI calls lived here)
```

## Screenshots

**Map**
![The interactive map, with severity-shaded markers and the accessible list of riots below it](assets/screenshots/map-page.png)

**Analyze Match**
![The Analyze Match questionnaire](assets/screenshots/analyze-match.png)

**Mitigation Factors**
![The Mitigation Factors reference page, with prevention and response side by side](assets/screenshots/mitigation-factors.png)

## Built with

Built by Rohan Satpathy, with [Claude](https://claude.ai) (Anthropic) used throughout as a coding assistant for implementation, debugging, and design iteration.
