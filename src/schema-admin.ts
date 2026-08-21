interface SchemaAdminPageOptions {
  nonce: string;
  siteTitle: string;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function renderSchemaAdminPage({ nonce, siteTitle }: SchemaAdminPageOptions): string {
  const safeNonce = escapeHtml(nonce);
  const safeTitle = escapeHtml(siteTitle);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light dark">
    <title>${safeTitle} · Schema Inventory</title>
    <style nonce="${safeNonce}">
      :root { font: 15px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; color-scheme: light dark; }
      body { margin: 0; background: Canvas; color: CanvasText; }
      main { width: min(84rem, calc(100% - 2rem)); margin: 2rem auto 5rem; }
      a { color: LinkText; }
      header { display: grid; gap: 1rem; margin: 2rem 0; }
      h1 { margin: 0; font: 750 clamp(2.4rem, 8vw, 6rem)/.9 system-ui, sans-serif; letter-spacing: -.07em; }
      header p { max-width: 58rem; color: GrayText; }
      .controls { display: flex; flex-wrap: wrap; gap: .75rem; }
      input, select { border: 1px solid color-mix(in srgb, CanvasText 28%, transparent); border-radius: .45rem; padding: .65rem .8rem; background: Canvas; color: CanvasText; font: inherit; }
      input { flex: 1 1 20rem; }
      #summary { color: GrayText; }
      #schemas { display: grid; gap: .8rem; }
      article { border: 1px solid color-mix(in srgb, CanvasText 24%, transparent); border-radius: .7rem; padding: 1rem; }
      article[data-category="business"] { border-left: .45rem solid #e45d2a; }
      .title { display: flex; flex-wrap: wrap; align-items: baseline; gap: .6rem; }
      h2 { margin: 0; font: 650 1.2rem system-ui, sans-serif; }
      code, .tag { background: color-mix(in srgb, CanvasText 9%, transparent); border-radius: .25rem; padding: .12rem .35rem; }
      .tag { text-transform: uppercase; font-size: .72rem; letter-spacing: .08em; }
      .schema-id, .description { overflow-wrap: anywhere; color: GrayText; }
      .properties { display: flex; flex-wrap: wrap; gap: .35rem; margin: .8rem 0; }
      details { margin-top: .7rem; }
      pre { max-height: 32rem; overflow: auto; border-radius: .4rem; padding: 1rem; background: color-mix(in srgb, CanvasText 7%, transparent); font-size: .8rem; }
      #empty { color: GrayText; border: 1px dashed GrayText; border-radius: .7rem; padding: 2rem; }
    </style>
  </head>
  <body>
    <main>
      <nav><a href="/">← Back to ${safeTitle}</a></nav>
      <header>
        <h1>Business objects</h1>
        <p>Every JSON Schema and its derived TypeScript type. Business models lead; API and system contracts remain visible for a complete project inventory.</p>
        <div class="controls">
          <input id="search" type="search" placeholder="Search names, types, properties…" aria-label="Search schemas">
          <select id="category" aria-label="Filter by category">
            <option value="all">All categories</option>
            <option value="business">Business</option>
            <option value="api">API</option>
            <option value="system">System</option>
          </select>
        </div>
        <output id="summary" aria-live="polite">Loading schemas…</output>
      </header>
      <section id="schemas"></section>
    </main>
    <script nonce="${safeNonce}">
      const search = document.querySelector('#search');
      const category = document.querySelector('#category');
      const container = document.querySelector('#schemas');
      const summary = document.querySelector('#summary');
      let catalog = [];
      const render = () => {
        const query = search.value.trim().toLowerCase();
        const selected = category.value;
        const shown = catalog.filter((entry) => {
          const haystack = [entry.title, entry.typeName, entry.description, entry.schemaId, ...Object.keys(entry.schema.properties ?? {})].join(' ').toLowerCase();
          return (selected === 'all' || entry.category === selected) && (!query || haystack.includes(query));
        });
        container.replaceChildren();
        summary.textContent = shown.length + ' of ' + catalog.length + ' schemas';
        if (!shown.length) {
          const empty = document.createElement('p');
          empty.id = 'empty';
          empty.textContent = 'No schemas match this filter.';
          container.append(empty);
          return;
        }
        for (const entry of shown) {
          const article = document.createElement('article'); article.dataset.category = entry.category;
          const title = document.createElement('div'); title.className = 'title';
          const heading = document.createElement('h2'); heading.textContent = entry.title;
          const typeName = document.createElement('code'); typeName.textContent = entry.typeName;
          const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = entry.category;
          title.append(heading, typeName, tag);
          const description = document.createElement('p'); description.className = 'description'; description.textContent = entry.description;
          const schemaId = document.createElement('div'); schemaId.className = 'schema-id'; schemaId.textContent = entry.schemaId;
          const properties = document.createElement('div'); properties.className = 'properties';
          for (const property of Object.keys(entry.schema.properties ?? {})) {
            const label = document.createElement('code');
            label.textContent = property + ((entry.schema.required ?? []).includes(property) ? ' *' : '');
            properties.append(label);
          }
          const details = document.createElement('details');
          const detailsTitle = document.createElement('summary'); detailsTitle.textContent = 'JSON Schema';
          const pre = document.createElement('pre'); pre.textContent = JSON.stringify(entry.schema, null, 2);
          details.append(detailsTitle, pre);
          article.append(title, description, schemaId, properties, details);
          container.append(article);
        }
      };
      search.addEventListener('input', render);
      category.addEventListener('change', render);
      fetch('/api/admin/schemas', { cache: 'no-store' })
        .then((response) => response.json())
        .then((payload) => { catalog = payload.schemas; render(); })
        .catch(() => { summary.textContent = 'Schema inventory unavailable'; });
    </script>
  </body>
</html>`;
}
