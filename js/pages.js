'use strict';

// ---- shared ----
// Pieces shared by pages: the PAGES registry, the page header and the card every page uses, inline rename, graph previews, Library helpers.

const PAGES = {};
/** Update only a page's live regions; keep forms and focus. */
function livePage(route, update) {
  let stopped = false,
    busy = false,
    again = false,
    timer;
  const run = async () => {
    if (stopped || app.route !== route || document.hidden) return;
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    try {
      await update();
      if (!stopped && app.route === route) {
        const status = $('[data-live-status]');
        if (status) status.textContent = 'Live';
      }
    } catch {
      if (!stopped && app.route === route) {
        const status = $('[data-live-status]');
        if (status) status.textContent = 'Connection interrupted · retrying';
      }
    } finally {
      busy = false;
      if (again && !stopped) {
        again = false;
        schedule();
      }
    }
  };
  const schedule = () => {
    if (!timer)
      timer = setTimeout(() => {
        timer = null;
        run();
      }, 250);
  };
  const unsubscribe = Environment.subscribe(schedule);
  const interval = setInterval(run, 3000);
  document.addEventListener('visibilitychange', schedule);
  app.pageDispose = () => {
    stopped = true;
    clearTimeout(timer);
    clearInterval(interval);
    unsubscribe();
    document.removeEventListener('visibilitychange', schedule);
  };
  return run;
}
/** A common save lifecycle for settings pages and Library resource editors. */
function pageAutosave(form, read, write) {
  const save = autoForm(form, read, write),
    status = $('.save-status', form);
  $('#save-slot', $('#view'))?.replaceWith(status);
  app.pageSave = save;
  leaveGuards.push(async () => {
    const ok = await leaveAutosave(save);
    if (ok && app.pageSave === save) app.pageSave = null;
    return ok;
  });
  return save;
}
const COMMON_CAPABILITIES = [
  'graph.read',
  'graph.write',
  'library.read',
  'library.write',
  'net.fetch:*',
  'run.read',
  'run.start',
];
function permissionChoices(capabilities, grants, attr = 'data-grant', prefix = 'grant') {
  return `<table class="permission-table"><thead><tr><th scope="col">Permission</th><th scope="col">Allow</th><th scope="col">Disallow</th></tr></thead><tbody>${capabilities.map(cap => `<tr><th scope="row">${esc(cap)}</th><td><label class="permission-choice"><input type="radio" name="${prefix}:${esc(cap)}" value="allow" ${attr}="${esc(cap)}" aria-label="Allow ${esc(cap)}" ${grants.includes(cap) ? 'checked' : ''}></label></td><td><label class="permission-choice"><input type="radio" name="${prefix}:${esc(cap)}" value="disallow" aria-label="Disallow ${esc(cap)}" ${grants.includes(cap) ? '' : 'checked'}></label></td></tr>`).join('')}</tbody></table>`;
}
function grantControls(
  grants = [],
  {hint = 'Permissions are limited by the parent node.', title = 'Permissions', prefix = 'grant'} = {}
) {
  const extra = grants.filter(v => !COMMON_CAPABILITIES.includes(v)).join(', ');
  return `<fieldset class="permission-controls" data-grants title="${esc(hint)}"><legend title="${esc(hint)}">${esc(title)}</legend><div class="permission-fields">${permissionChoices(COMMON_CAPABILITIES, grants, 'data-grant', prefix)}<label class="field"><span>Specific permissions</span><input name="extra_grants" value="${esc(extra)}" placeholder="net.fetch:example.com"></label></div></fieldset>`;
}
function readGrantControls(root) {
  const box = $('[data-grants]', root);
  return [
    ...new Set([
      ...$$('input[data-grant]:checked', box).map(el => el.getAttribute('data-grant')),
      ...(box.querySelector('[name=extra_grants]').value || '')
        .split(',')
        .map(v => v.trim())
        .filter(Boolean),
    ]),
  ];
}
/**
 * Splits a settings form into sections shown one at a time. The list of sections lives in the second panel
 * (a form with one section needs none); the open one is remembered by the page's tab.
 */
function showSectionPanel(form, section = sectionOf(app.route)) {
  const definitions = SECTION_PANELS[section];
  const sections = [...form.children].filter(el => el.tagName === 'SECTION');
  if (!definitions || definitions.length < 2) return;
  const index = definitions.findIndex(([key]) => key === selectedPanel(section));
  sections.forEach((section, i) => {
    section.id ||= 'section-panel-' + i;
    section.hidden = i !== index;
  });
  form.addEventListener(
    'invalid',
    event => {
      const i = sections.findIndex(s => s.contains(event.target));
      if (i >= 0 && sections[i].hidden) go(sectionHref(section, definitions[i][0])).catch(fail);
    },
    true
  );
}
const actionButton = (menu, label = 'Actions') =>
  menu
    ? `<button type="button" class="icon" data-menu="${esc(menu)}" title="${esc(label)}" aria-label="${esc(label)}">${icon('dots')}</button>`
    : '';

/** The common page heading, description and actions. `title` and `sub` are HTML. */
const pageHead = ({title, sub = '', glyph = '', actions = '', menu = pageMenu()}) =>
  `<header class="page-head"><div><h1 class="page-title"${sub ? ` title="${sub.replace(/"/g, '&quot;')}"` : ''}>${glyph ? icon(glyph) : ''}${title}</h1></div><div class="actions">${actions}${actionButton(menu)}</div></header>`;

/**
 * The card of every page (projects, workflows, Library nodes and groups), built like a node of the canvas: a header with an icon
 * and the name, a well showing what is inside, a line of facts, and its buttons. `menu` is what its "⋯" opens (see menuItems in nav.js);
 * `attrs` marks the title for renaming on the spot; `tint` is "k-complex" for what is made of other nodes; `extra` goes on the card itself.
 */
function card({
  href,
  glyph,
  title,
  attrs = '',
  preview = '',
  previewAttrs = '',
  previewClass = '',
  facts = '',
  menu = '',
  tint = '',
  extra = '',
}) {
  const tag = href ? 'a' : 'div';
  return `<article class="card ${tint}" ${extra}><${tag} class="card-main" ${href ? `href="${esc(href)}" data-link` : ''}><header class="card-head"><span class="head-icon">${icon(glyph)}</span><h3><span ${attrs}>${esc(title)}</span></h3></header><div class="card-preview ${previewClass}" ${previewAttrs}>${preview}</div>${facts ? `<p class="card-facts">${facts}</p>` : ''}</${tag}><span class="card-actions">${menu ? `<button type="button" class="icon" data-menu="${esc(menu)}" aria-label="Actions of ${esc(title)}">${icon('dots')}</button>` : ''}</span></article>`;
}

function inlineRename(title, value, save, {maxLength = 100, pattern = ''} = {}) {
  if (typeof title === 'function') title = title();
  title ||= $('.page-head h1');
  if (!title || $('.inline-rename', title)) return;
  const input = document.createElement('input');
  input.className = 'inline-rename';
  input.value = value;
  input.maxLength = maxLength;
  input.required = true;
  if (pattern) input.pattern = pattern;
  input.setAttribute('aria-label', 'Rename');
  title.replaceChildren(input);
  title.closest('[draggable]')?.setAttribute('draggable', 'false');
  const folded = title.closest('#subnav') && document.body.classList.contains('subnav-collapsed');
  if (folded) document.body.classList.remove('subnav-collapsed');
  let saving = false;
  const finish = text => {
    title.textContent = text;
    title.closest('[draggable]')?.setAttribute('draggable', 'true');
    if (folded) {
      document.body.classList.add('subnav-collapsed');
      followPills();
    }
  };
  const restore = () => {
    if (!saving) finish(value);
  };
  input.onblur = restore;
  input.onclick = event => {
    event.preventDefault();
    event.stopPropagation();
  };
  input.onpointerdown = event => event.stopPropagation();
  input.oninput = input.onchange = event => event.stopPropagation();
  input.onkeydown = async event => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      restore();
    }
    if (event.key !== 'Enter' || event.isComposing || saving) return;
    event.preventDefault();
    const next = input.value.trim();
    input.value = next;
    if (!input.reportValidity()) return;
    if (next === value) return restore();
    saving = true;
    input.disabled = true;
    try {
      await save(next);
      finish(next);
    } catch (error) {
      saving = false;
      restore();
      fail(error);
    }
  };
  input.focus();
  input.select();
}

function menuTitle(spec, owner) {
  const button = $(`[data-menu="${CSS.escape(spec)}"]`);
  const root = owner?.closest?.('.card,.subnav-row,.tab') || button?.closest('.card,.subnav-row');
  return root && $('h3 > span, :scope > a > span, :scope > .subnav-static > span, .tab-title', root);
}

document.addEventListener('keydown', async event => {
  if (
    event.defaultPrevented ||
    !matches('renameGroup', event) ||
    $('#modal').open ||
    event.target.closest('input,textarea,select,[contenteditable=true]')
  )
    return;
  const owner = event.target.closest('.card,.subnav-row,.tab');
  let spec = owner?.querySelector('[data-menu]')?.dataset.menu || owner?.dataset.menu;
  if (owner?.dataset.tab) {
    const [project, workflow] = owner.dataset.tab.split('/');
    spec = project.startsWith('lib-') ? 'resource:' + project.slice(4) : `workflow:${project}:${workflow}`;
  }
  if (!spec && app.route.workflow) {
    event.preventDefault();
    return renameSelection();
  }
  if (!spec && app.route.id && app.route.id !== 'new') spec = 'resource:' + app.route.id;
  if (!spec && app.route.folder) spec = 'folder:' + app.route.folder;
  if (!spec && app.route.project) spec = 'project:' + app.route.project;
  if (!spec) return;
  event.preventDefault();
  try {
    const action = (await menuItems(spec, owner))?.find(item => item?.[0] === 'Rename');
    action?.[1]();
  } catch (error) {
    fail(error);
  }
});

function previewSVG(graph) {
  const map = Graph.nodeMap(graph),
    groupsById = new Map(graph.groups.map(g => [g.id, g]));
  // Everything inside a collapsed Complex Node is drawn as that one node (the outermost one wins).
  const collapsed = graph.complex.filter(c => c.collapsed).sort((x, y) => x.depth - y.depth),
    hiddenBy = new Map(),
    hiddenGroups = new Set();
  for (const c of collapsed) {
    if (hiddenBy.has('complex:' + c.id)) continue;
    for (const id of c.members) if (!hiddenBy.has(id)) hiddenBy.set(id, 'complex:' + c.id);
    for (const g of graph.groups) if (g.id === c.id || isInside(groupsById, g, c.id)) hiddenGroups.add(g.id);
  }
  const nodes = [
    ...graph.nodes.filter(n => !hiddenBy.has(n.id)),
    ...collapsed
      .filter(c => !hiddenBy.has('complex:' + c.id))
      .map(c => ({...c, id: 'complex:' + c.id, kind: 'complex'})),
  ];
  if (!nodes.length) return '<span class="preview-empty">Empty workflow</span>';
  const positions = new Map(
    nodes.map((n, i) => {
      const p = n.position || {x: i * 280, y: 0};
      return [
        n.id,
        {
          x: p.x,
          y: p.y,
          w: n.kind === 'complex' ? n.compact_width : p.width || 236,
          h: n.kind === 'complex' ? n.compact_height : p.height || 90,
        },
      ];
    })
  );
  const boxes = [...positions.values()],
    x = Math.min(...boxes.map(p => p.x)) - 30,
    y = Math.min(...boxes.map(p => p.y)) - 30;
  const w = Math.max(...boxes.map(p => p.x + p.w)) - x + 30,
    h = Math.max(...boxes.map(p => p.y + p.h)) - y + 30;
  const endpoint = (id, port, direction) => {
    let at = id;
    try {
      at = Graph.resolve(map, id, port, direction)[0];
    } catch {
      /* dangling port */
    }
    return hiddenBy.get(at) || at;
  };
  const edges = graph.edges
    .map(e => {
      const from = endpoint(e.source, e.source_port, 'outputs'),
        to = endpoint(e.target, e.target_port, 'inputs');
      if (from === to) return '';
      const a = positions.get(from),
        b = positions.get(to);
      if (!a || !b) return '';
      return `<path d="${wirePath({x: a.x + a.w, y: a.y + 20}, {x: b.x, y: b.y + 20}, {wire_style: 'bezier', wire_curve: 50})}"/>`;
    })
    .join('');
  const frames = graph.groups
    .filter(g => !hiddenGroups.has(g.id))
    .sort((p, q) => p.depth - q.depth)
    .map(g => {
      const members = g.all_members.map(id => positions.get(id)).filter(Boolean);
      if (!members.length) return '';
      const pad = 15 + 8 * (3 - Math.min(3, g.depth));
      const left = Math.min(...members.map(p => p.x)) - pad,
        top = Math.min(...members.map(p => p.y)) - pad - 7;
      const width = Math.max(...members.map(p => p.x + p.w)) - left + pad,
        height = Math.max(...members.map(p => p.y + p.h)) - top + pad;
      return `<rect class="preview-frame" ${g.color ? `style="--c:${esc(g.color)}" ` : ''}x="${left}" y="${top}" width="${width}" height="${height}" rx="16"/>`;
    })
    .join('');
  return `<svg viewBox="${x} ${y} ${w} ${h}" aria-hidden="true">${frames}<g class="preview-wires">${edges}</g>${nodes
    .map(n => {
      const p = positions.get(n.id);
      return `<rect class="preview-node k-${n.kind === 'complex' ? 'complex' : 'node'} s-${esc(n.status || 'ready')}" ${n.color ? `style="--c:${esc(n.color)}" ` : ''}x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" rx="12"/>`;
    })
    .join('')}</svg>`;
}

/** Load only visible cards, with a bounded number of requests. */
function loadCardPreviews(view, projectId = null) {
  const queue = [];
  let active = 0,
    stopped = false;
  const run = () => {
    while (!stopped && active < 3 && queue.length) {
      const card = queue.shift();
      active++;
      (async () => {
        const pid = projectId || card.dataset.previewProject;
        const workflows = projectId
          ? [{id: card.dataset.previewWorkflow}]
          : (await api(`projects/${pid}/workflows`)).slice(0, 3);
        const graphs = [];
        for (const workflow of workflows) {
          if (stopped) return;
          graphs.push(await api(`projects/${pid}/workflow`, {query: {workflow_id: workflow.id}}));
        }
        if (stopped || !card.isConnected) return;
        card.innerHTML =
          graphs.map((g, i) => `<div class="preview-layer" style="--layer:${i}">${previewSVG(g)}</div>`).join('') ||
          '<span class="preview-empty">No workflows</span>';
      })()
        .catch(() => {
          if (card.isConnected) card.innerHTML = '<span class="preview-empty">Preview unavailable</span>';
        })
        .finally(() => {
          active--;
          run();
        });
    }
  };
  const observer = new IntersectionObserver(
    entries => {
      for (const entry of entries)
        if (entry.isIntersecting) {
          observer.unobserve(entry.target);
          queue.push(entry.target);
        }
      run();
    },
    {root: $('#view'), rootMargin: '100px'}
  );
  $$('[data-preview-project], [data-preview-workflow]', view).forEach(card => observer.observe(card));
  leaveGuards.push(() => {
    stopped = true;
    observer.disconnect();
  });
}

async function loadLibrary() {
  const settings = await api('settings');
  app.librarySections = [];
  app.resources = settings.resources;
  app.nodeFolders = settings.node_folders || [];
  app.nodeFolderIcons = settings.node_folder_icons || {};
  app.preferences = settings.preferences;
  return settings;
}
const baseName = path => path.slice(path.lastIndexOf('/') + 1);
/** The Library has sections (now one: Nodes) under /library; the nodes live at /library/nodes. */
const NODES_PATH = '/library/nodes';
const resourceHref = r => `${NODES_PATH}/${r.id}`;
const folderHref = path => `${NODES_PATH}?folder=${encodeURIComponent(path)}`;
const folderKey = path => 'f:' + path;
const resourceIcon = r => r.payload.icon || 'complex';

/** A saved Custom Node as the graph previewSVG draws: its nodes where they are, the groups around their members, the wires. */
function graphFromBundle(bundle) {
  const groups = bundle?.groups || [],
    byId = new Map(groups.map(g => [g.id, g])),
    depth = g => (byId.has(g.parent) ? 1 + depth(byId.get(g.parent)) : 0),
    members = g => [...g.members, ...groups.filter(x => x.parent === g.id).flatMap(members)];
  return {
    nodes: [
      ...(bundle?.notes || []).map(n => ({id: n.id, kind: 'node'})),
      ...(bundle?.records || []).map(n => ({id: n.id, kind: 'function'})),
    ].map(n => ({
      ...n,
      position: bundle.positions?.[n.id],
      color: bundle.styles?.[n.id]?.color,
      inputs: [],
      outputs: [],
    })),
    edges: bundle?.port_edges || [],
    complex: [],
    groups: groups.map(g => ({...g, depth: depth(g), all_members: members(g)})),
  };
}

// ---- projects ----
// Pages: the project list and one project with its workflows.

// ----- projects -----
const EMPTY_PROJECTS =
  '<div class="empty"><h2 title="Projects keep related workflows together. Create one or explore a working example.">Start your first project</h2><div class="button-row"><button type="button" class="primary" data-new-project>New project</button><button type="button" data-example>Open example</button></div></div>';
PAGES.projects = async (view, route) => {
  await loadProjects();
  if (app.route !== route) return;
  view.innerHTML = `<div class="page">${pageHead({title: 'Projects'})}
    <div class="cards">${app.projects
      .map(p =>
        card({
          href: `/p/${p.id}`,
          glyph: 'folder',
          title: p.name,
          attrs: `data-project-title="${esc(p.id)}"`,
          previewAttrs: `data-preview-project="${esc(p.id)}" aria-label="Project workflow previews"`,
          previewClass: 'preview-stack',
          facts: plural(p.workflow_count, 'workflow') + (p.description ? ' · ' + esc(p.description) : ''),
          menu: 'project:' + p.id,
        })
      )
      .join('')}</div>${app.projects.length ? '' : EMPTY_PROJECTS}</div>`;
  loadCardPreviews(view);
  bindWelcome($('.page', view));
};

/** Menu of a project (card or row of the second panel). `title` is the element showing its name, if it is on the page. */
function projectActions(project, title = $(`[data-project-title="${CSS.escape(project.id)}"]`)) {
  return [
    ['New workflow', () => newWorkflowDialog(project), {icon: 'plus'}],
    [
      'Rename',
      () =>
        inlineRename(title, project.name, async name => {
          await api(`projects/${project.id}`, {method: 'PATCH', body: {name}});
          project.name = name;
          Tabs.renameProject(project.id, name);
          renderSidebar();
          if (app.route.project === project.id) await render();
        }),
      {icon: 'pencil'},
    ],
    [
      'Duplicate',
      async () => {
        const copy = await api(`projects/${project.id}/duplicate`, {method: 'POST'});
        toast(
          copy?.id ? `Project duplicated. [Open the copy](/p/${encodeURIComponent(copy.id)})` : 'Project duplicated.'
        );
        await loadProjects();
        await render();
      },
      {icon: 'copy'},
    ],
    ['Export project', () => exportProject(project), {icon: 'upload'}],
    ['Import graph', () => importWorkflows(project.id), {icon: 'download'}],
    ['Settings', () => go(`/p/${project.id}/settings`), {icon: 'settings'}],
    null,
    [
      'Delete',
      () =>
        confirmDialog(
          'Delete project?',
          `“${project.name}” and all of its workflows will be removed.`,
          async () => {
            await api(`projects/${project.id}`, {method: 'DELETE'});
            Tabs.dropProject(project.id);
            await loadProjects();
            if (app.route.project === project.id) await go('/projects');
            else await render();
          },
          'Delete project'
        ),
      {danger: true, icon: 'trash'},
    ],
  ];
}

async function newProjectDialog() {
  const defaults = await api('project-defaults');
  dialog(
    'New project',
    field('Name', `<input name="name" maxlength="100" autofocus placeholder="${esc(defaults.name)}">`),
    async form => {
      const created = await api('projects', {
        method: 'POST',
        body: {name: form.name.value.trim(), auto_name: !form.name.value.trim()},
      });
      await loadProjects();
      await go(`/p/${created.id}`);
    },
    'Create project'
  );
}

async function runFromCard(projectId, workflow, button) {
  if (button) button.disabled = true;
  try {
    await api('projects/' + projectId + '/execution', {method: 'POST', body: {workflow_id: workflow.id}});
    await go('/p/' + projectId + '/w/' + workflow.id);
  } finally {
    if (button) button.disabled = false;
  }
}

// ----- project -----
PAGES.project = async (view, route) => {
  const {project, workflows} = await api(`projects/${route.project}`);
  if (app.route !== route) return;
  view.innerHTML = `<div class="page">${pageHead({
    title: esc(project.name),
    sub: esc(project.description || ''),
  })}
    <div class="cards">${workflows
      .map(w =>
        card({
          href: `/p/${project.id}/w/${w.id}`,
          glyph: 'node',
          title: w.name,
          attrs: `data-workflow-title="${esc(w.id)}"`,
          previewAttrs: `data-preview-workflow="${esc(w.id)}" aria-label="Workflow preview"`,

          menu: `workflow:${project.id}:${w.id}`,
        })
      )
      .join('')}</div></div>`;
  loadCardPreviews(view, project.id);
};
function newWorkflowDialog(project) {
  dialog(
    'New workflow',
    field('Name', '<input name="name" required maxlength="100" autofocus value="Workflow">'),
    async form => {
      const created = await api(`projects/${project.id}/workflows`, {
        method: 'POST',
        body: {name: form.elements.name.value},
      });
      await go(`/p/${project.id}/w/${created.id}`);
    },
    'Create'
  );
}

/** Menu of a workflow (its card or its row in the second panel). */
function workflowActions(projectId, workflow, title) {
  const refresh = async () => {
    await Promise.all([loadProjects(), loadProjectWorkflows(projectId, true)]);
    await render();
  };
  return [
    ...(app.route?.page === 'workflow' && app.route.project === projectId && app.route.workflow === workflow.id
      ? []
      : [['Run', () => runFromCard(projectId, workflow), {icon: 'play'}]]),
    [
      'Rename',
      () =>
        inlineRename(title, workflow.name, async name => {
          await api(`projects/${projectId}/workflows/${workflow.id}`, {method: 'PATCH', body: {name}});
          workflow.name = name;
          Tabs.rename(workflow.id, name);
          await refresh();
        }),
      {icon: 'pencil'},
    ],
    [
      'Duplicate',
      async () => {
        await api(`projects/${projectId}/workflows/${workflow.id}/duplicate`, {method: 'POST', body: {}});
        await refresh();
      },
      {icon: 'copy'},
    ],
    ['Export graph', () => exportWorkflow(projectId, workflow), {icon: 'upload'}],
    ['Import graph', () => importWorkflows(projectId, workflow.id), {icon: 'download'}],
    null,
    [
      'Delete',
      () =>
        confirmDialog(
          'Delete workflow?',
          `“${workflow.name}” and its canvas will be removed.`,
          async () => {
            await api(`projects/${projectId}/workflows/${workflow.id}`, {method: 'DELETE'});
            Tabs.drop(workflow.id);
            await Promise.all([loadProjects(), loadProjectWorkflows(projectId, true)]);
            if (app.route.workflow === workflow.id) await go(`/p/${projectId}`);
            else await render();
          },
          'Delete workflow'
        ),
      {danger: true, icon: 'trash'},
    ],
  ];
}

async function exportProject(project) {
  if (W.project === project.id && document.querySelector('#canvas')) await flushNodeEdits();
  downloadJSON(await api(`projects/${project.id}/export`), `${project.name}.project`);
}
async function exportWorkflow(projectId, workflow) {
  if (W.project === projectId && W.workflow === workflow.id && document.querySelector('#canvas'))
    await flushNodeEdits();
  downloadJSON(await api(`projects/${projectId}/workflows/${workflow.id}/export`), `${workflow.name}.workflow`);
}
async function importProjects() {
  const files = await pickFiles();
  let last;
  for (const file of files) {
    const data = JSON.parse(await file.text());
    if (TextGraph.decode(data).kind !== 'project') throw new Error(`${file.name}: choose an exported project.`);
    last = await api('projects/import', {method: 'POST', body: data});
  }
  if (last) {
    await loadProjects();
    await go(`/p/${last.id}`);
  }
}
async function importWorkflows(projectId, workflowId = null) {
  const files = await pickFiles();
  const graphs = [];
  for (const file of files) {
    const packet = JSON.parse(await file.text()), graph = TextGraph.decode(packet);
    if (!['workflow', 'graph'].includes(graph.kind) || !graph.document)
      throw new Error(`${file.name}: choose an exported workflow graph.`);
    graphs.push({packet, graph, file});
  }
  if (!graphs.length) return;
  if (workflowId) {
    const open = W.project === projectId && W.workflow === workflowId && W.canvas?.isConnected;
    if (open) await flushNodeEdits();
    const point = open ? spawnPoint() : {x: 0, y: 0};
    let last;
    for (const {packet} of graphs) {
      last = await api(`projects/${projectId}/import-graph`, {
        method: 'POST', body: {workflow_id: workflowId, graph: packet, point}, edit: editToken(),
      });
      point.x += 48; point.y += 48;
    }
    if (W.project === projectId && W.workflow === workflowId && W.canvas?.isConnected) {
      await reload();
      select(pastedSelection(last));
    }
    toast('Graph imported.');
    return;
  }
  dialog('Import graph into project', graphs.map(({graph, file}, index) =>
    field(file.name, `<input name="graph-${index}" value="${esc(graph.name || 'Imported workflow')}" required maxlength="100" ${index ? '' : 'autofocus'}>`)
  ).join(''), async form => {
    let last;
    for (const [index, {graph}] of graphs.entries()) {
      const name = form.elements.namedItem('graph-' + index).value.trim();
      if (!name) throw new Error('Enter a workflow name.');
      last = await api(`projects/${projectId}/workflows/import`, {method: 'POST', body: TextGraph.encode({...graph, name})});
    }
    await Promise.all([loadProjects(), loadProjectWorkflows(projectId, true)]);
    await go(`/p/${projectId}/w/${last.id}`);
  }, 'Import');
}

// ---- settings ----
// Pages: project settings and application settings.

// ----- project settings -----
PAGES['project-settings'] = async (view, route) => {
  const {project} = await api(`projects/${route.project}`);
  if (app.route !== route) return;
  view.innerHTML = `<form class="page form-page" id="project-form">${pageHead({
    title: 'Project settings',
    actions: '<span id="save-slot"></span>',
  })}
    <section><h2>General</h2>${field('Name', `<input name="name" required maxlength="100" value="${esc(project.name)}">`)}
      ${field('Description', `<textarea name="description" rows="4" maxlength="2000" title="What is this project for?">${esc(project.description)}</textarea>`)}</section>
    <p class="form-error" hidden></p></form>`;
  const form = $('#project-form');
  pageAutosave(
    form,
    () => ({name: form.name.value.trim(), description: form.description.value}),
    async body => {
      await api(`projects/${project.id}`, {method: 'PUT', body});
      await loadProjects();
    }
  );
};

// ----- application settings -----
const PALETTE = ['background', 'surface', 'text', 'accent'];
/** The built-in theme whose four colours these are ('' for a custom palette). */
const themeOf = style => Object.keys(THEMES).find(name => PALETTE.every(k => THEMES[name][k] === style[k])) ?? '';
const graphNumber = (name, style) => {
  const [min, max] = GRAPH_RANGES[name];
  return `<input name="${name}" type="number" min="${min}" max="${max}" value="${style[name]}">`;
};
PAGES.settings = async (view, route) => {
  const {preferences} = await loadLibrary();
  if (app.route !== route) return;
  const style = {...STYLE_DEFAULTS, ...preferences.style};
  view.innerHTML = `<form class="page form-page" id="settings-form">${pageHead({title: 'Settings', actions: '<span id="save-slot"></span>'})}
    <section><h2>Editing</h2>${field('Undo steps per workflow', `<input name="undo_steps" type="number" min="0" max="500" value="${esc(preferences.undo_steps ?? 50)}">`)}
      <label class="check"><input type="checkbox" name="developer_mode" ${preferences.developer_mode ? 'checked' : ''}> Developer mode</label></section>
    <section class="appearance-section"><h2>Appearance</h2>
      <div class="settings-group"><h3 title="Pick a built-in theme, or set the four colours below yourself.">Theme</h3>
        <select name="theme" aria-label="Theme"><option value="">Custom</option>${options(
          Object.keys(THEMES).map(name => [name, name]),
          themeOf(style)
        )}</select></div>
      <div class="settings-group"><h3 title="The four colours every other colour is made from.">Colours</h3>
        <div class="colour-fields">${PALETTE.map(k => `<label class="colour-field"><input type="color" name="${k}" value="${esc(style[k])}" aria-label="${k}"><span>${k[0].toUpperCase() + k.slice(1)}</span></label>`).join('')}</div></div>
      <div class="settings-group"><h3>Text</h3>
        <div class="settings-grid">${field('Text size', `<input name="font_size" type="number" min="12" max="22" value="${style.font_size}">`)}
        ${field('Font', `<select name="font_family">${options([['system', 'System'], ...['Arial', 'Verdana', 'Georgia', 'Trebuchet MS', 'Courier New'].map(f => [f, f])], style.font_family)}</select>`)}</div></div>
      <div class="settings-group"><h3>Interface</h3>
        <label class="toggle-row"><input type="checkbox" name="animations" ${style.animations ? 'checked' : ''}><span><strong title="Panels, pills and menus move instead of jumping.">Animations</strong></span></label>
        <label class="toggle-row"><input type="checkbox" name="effects" ${style.effects ? 'checked' : ''}><span><strong title="Blur, glow and connected panels.">Effects</strong></span></label></div>
      <div class="settings-group"><h3>Graph editor</h3>
        <div class="settings-grid">${field('Wire style', `<select name="wire_style">${options(WIRE_STYLES, style.wire_style)}</select>`)}
        ${field('Wire thickness', graphNumber('wire_width', style))}
        ${field('Wire curve (Bezier, %)', graphNumber('wire_curve', style))}
        ${field('Node corner radius', graphNumber('node_radius', style))}
        ${field('Group corner radius', graphNumber('group_radius', style))}</div></div>
    </section>
    <section><h2>Keyboard shortcuts</h2>
      <div class="shortcuts">${Object.entries(SHORTCUT_LABELS)
        .map(
          ([action, label]) =>
            `<span>${esc(label)}</span><button type="button" class="key" data-action="${action}">${esc(shortcutText(action))}</button>`
        )
        .join('')}</div>
</section></form><div id="settings-extensions"></div>`;
  const form = $('#settings-form');
  if (typeof Extensions !== 'undefined') Extensions.renderSettings($('#settings-extensions', view));
  showSectionPanel(form);
  let shortcuts = {...(preferences.shortcuts || {})};
  const readStyle = () => ({
    font_size: Number(form.font_size.value),
    font_family: form.font_family.value,
    animations: form.animations.checked,
    effects: form.effects.checked,
    wire_style: form.wire_style.value,
    ...Object.fromEntries(
      Object.keys(GRAPH_RANGES).map(k => [
        k,
        clamp(form[k].value.trim() === '' ? GRAPH_DEFAULTS[k] : Math.round(Number(form[k].value)), ...GRAPH_RANGES[k]),
      ])
    ),
    ...Object.fromEntries(PALETTE.map(k => [k, form[k].value])),
  });
  // A colour picker reports dozens of changes a second. Each one only marks the page dirty; the page is restyled once per frame, with the
  // transitions off (hundreds of elements would otherwise start animating towards a colour that is already out of date).
  let frame = 0,
    settle = 0;
  const preview = () => {
    frame = 0;
    const current = readStyle();
    form.theme.value = themeOf(current);
    setRootData('liveEdit', '');
    applyStyle(current);
    clearTimeout(settle);
    settle = setTimeout(() => delete document.documentElement.dataset.liveEdit, 200);
  };
  form.oninput = event => {
    if (event.target.name === 'theme' && THEMES[form.theme.value])
      for (const k of PALETTE) form[k].value = THEMES[form.theme.value][k];
    frame ||= requestAnimationFrame(preview);
  };
  leaveGuards.push(() => {
    cancelAnimationFrame(frame);
    clearTimeout(settle);
    delete document.documentElement.dataset.liveEdit;
  });
  const save = pageAutosave(
    form,
    () => ({
      undo_steps: clamp(Math.round(Number(form.undo_steps.value)) || 0, 0, 500),
      developer_mode: form.developer_mode.checked,
      style: readStyle(),
      shortcuts,
    }),
    async body => {
      app.preferences = await api('settings', {method: 'PUT', body});
      // What was saved may already be behind what the pickers show now: then the pickers win and the next save follows.
      if (!save.isDirty()) applyStyle(app.preferences.style);
      Tabs.render();
    }
  );
  // Whatever was previewed but could not be saved is dropped when the page is left.
  leaveGuards.push(() => applyStyle(app.preferences.style));
  for (const button of $$('.key', form))
    button.onkeydown = event => {
      if (event.key === 'Tab') return;
      event.preventDefault();
      const value = event.key === 'Backspace' ? '' : recordShortcut(event);
      if (
        ['Shift', 'Control', 'Alt', 'Meta'].includes(value) &&
        !['pan', 'multiSelect'].includes(button.dataset.action)
      )
        return;
      shortcuts[button.dataset.action] = value;
      button.textContent = value || '—';
      save.changed();
    };
  app.restoreSettings = () =>
    confirmDialog(
      'Restore default settings?',
      'Theme, appearance, undo steps and keyboard shortcuts return to their defaults.',
      async () => {
        await save(); // nothing pending may overwrite the defaults afterwards
        app.preferences = await api('settings', {
          method: 'PUT',
          body: {undo_steps: 50, style: STYLE_DEFAULTS, shortcuts: {}},
        });
        applyStyle(app.preferences.style);
        leaveGuards = [];
        await render();
      },
      'Restore'
    );
};

// ---- plugins ----
// Client plugins: packages installed in this browser, run in a sandboxed iframe (js/plugin-host.js).
// The server does not load plugins. Installing a package changes this browser; deploying its declared resources
// changes one server through the plugin's own capabilities. Server resources keep working without either.

async function loadPlugins({reload = false} = {}) {
  await PluginStore.load();
  app.plugins = PluginStore.list();
  if (typeof Extensions !== 'undefined') {
    if (reload) await Extensions.reload(app.plugins);
    else await Extensions.sync(app.plugins);
  }
  renderSidebar();
  return app.plugins;
}

const reloadPlugins = async () => {
  app.plugins = PluginStore.list();
  if (typeof Extensions !== 'undefined') await Extensions.reload(app.plugins);
  return app.plugins;
};

const setPluginEnabled = async (id, enabled) => {
  if (enabled) await Extensions.enable(id);
  else await Extensions.disable(id);
  app.plugins = PluginStore.list();
  return app.route?.id ? undefined : go('/plugins', true);
};

const dependencyText = plugin => {
  return (plugin.dependencies || []).join(', ') || 'none';
};

const pluginActions = plugin =>
  plugin && [
    plugin.enabled
      ? ['Turn off', () => setPluginEnabled(plugin.id, false).catch(fail), {icon: 'power'}]
      : ['Turn on', () => setPluginEnabled(plugin.id, true).catch(fail), {icon: 'power'}],
    ['Reload', () => reloadPlugins().then(() => (app.route?.id ? render() : go('/plugins', true))).catch(fail), {icon: 'refresh'}],
    ...(Extensions.errorOf(plugin.id) || Extensions.isFailed(plugin.id)
      ? [['Try again', () => Extensions.recover(plugin.id).then(() => render()).catch(fail), {icon: 'refresh'}]]
      : []),
    null,
    ['Export package…', () => exportPlugin(plugin.id), {icon: 'upload'}],
    ['Remove plugin…', () => removePlugin(plugin), {icon: 'x', danger: true}],
  ];

function removePlugin(plugin) {
  confirmDialog(
    'Remove client plugin?',
    `"${plugin.title}" and the values it stored in this browser are removed. Library nodes, collections and workflows it deployed on the server stay and keep running.`,
    async () => {
      await Extensions.uninstall(plugin.id);
      await reloadPlugins();
      toast('Plugin removed. Its server resources are unchanged.');
      await go('/plugins', true);
    },
    'Remove'
  );
}

const pluginCard = p => {
  const uiError = typeof Extensions === 'undefined' ? '' : Extensions.errorOf(p.id);
  const deps = (p.dependencies || []).length;
  return card({
    href: '/plugins/' + encodeURIComponent(p.id),
    glyph: p.icon || 'plug',
    title: p.title,
    attrs: `data-plugin="${esc(p.id)}" title="${esc(p.description || p.id)}"`,
    preview: uiError
      ? `<p class="form-error">${esc(uiError)}</p>`
      : `<code>${esc(p.id)}</code><br><span class="muted small">v${esc(p.version)} · API ${p.api}${deps ? ` · ${deps} dependenc${deps === 1 ? 'y' : 'ies'}` : ''}</span>`,
    previewClass: 'card-note',
    facts: uiError ? 'Interface failed' : p.enabled ? 'Running · sandboxed' : 'Off',
    menu: 'plugin:' + p.id,
    tint: p.enabled ? 'k-complex' : '',
  });
};

/** The capabilities field is a comma separated list; empty means the read-only default. */
const readCapabilities = form => {
  const values = String(form.elements.capabilities?.value || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  return values.length ? values : undefined;
};

/** What a plugin's sandbox put into the interface while it is running. */
function pluginInterface(plugin) {
  if (!plugin.enabled)
    return '<p class="muted">The plugin is off: its interface is not loaded.</p>';
  if (typeof Extensions === 'undefined') return '<p class="muted">The interface host is not available.</p>';
  const ui = Extensions.describe(plugin.id);
  const list = (items, empty) =>
    items.length ? `<ul class="plugin-contributions">${items.map(item => `<li>${esc(item)}</li>`).join('')}</ul>` : `<p class="muted">${empty}</p>`;
  return `${ui.error ? `<p class="form-error plugin-error">${esc(ui.error)}</p>` : ''}
    <dl class="page-facts">
      <div><dt>Pages</dt><dd>${ui.pages.length}</dd></div>
      <div><dt>Commands</dt><dd>${ui.commands.length}</dd></div>
      <div><dt>Toolbar</dt><dd>${ui.toolbar.length}</dd></div>
      <div><dt>Menus</dt><dd>${ui.menu.length}</dd></div>
      <div><dt>Settings</dt><dd>${ui.settings.length}</dd></div>
      <div><dt>Library</dt><dd>${ui.library.length}</dd></div>
      <div><dt>Inspector</dt><dd>${ui.inspector.length}</dd></div>
      <div><dt>Views</dt><dd>${ui.views.length}</dd></div>
      <div><dt>Styles</dt><dd>${ui.styles}</dd></div>
    </dl>
    ${
      ui.pages.length
        ? `<h3>Pages</h3><ul class="plugin-contributions">${ui.pages
            .map(page => `<li><a href="${esc(page.href)}" data-link>${esc(page.title)}</a></li>`)
            .join('')}</ul>`
        : ''
    }
    ${ui.commands.length ? `<h3>Commands</h3>${list(ui.commands, 'No commands.')}` : ''}
    ${ui.menu.length ? `<h3>Menus</h3>${list(ui.menu, 'No menu items.')}` : ''}
    ${ui.home.length ? `<h3>Dashboard</h3>${list(ui.home, 'No cards.')}` : ''}
    ${ui.settings.length ? `<h3>Settings sections</h3>${list(ui.settings, '')}` : ''}
    ${ui.library.length ? `<h3>Library sections</h3>${list(ui.library, '')}` : ''}
    ${ui.inspector.length ? `<h3>Inspector sections</h3>${list(ui.inspector, '')}` : ''}
    ${ui.views.length ? `<h3>Resource views</h3>${list(ui.views, '')}` : ''}`;
}

function pluginEditor(plugin = {}) {
  return `<form id="plugin-editor" class="stack">
    ${field('Id', `<input name="id" required value="${esc(plugin.id || '')}" ${plugin.id ? 'readonly' : ''} placeholder="my-plugin" autocomplete="off">`)}
    ${field('Title', `<input name="title" required maxlength="120" value="${esc(plugin.title || '')}" placeholder="My plugin">`)}
    ${field('Version label', `<input name="version" value="${esc(plugin.version || '0.1.0')}" placeholder="0.1.0" autocomplete="off">`)}
    ${field('Description', `<textarea name="description" rows="2" maxlength="2000">${esc(plugin.description || '')}</textarea>`)}
    ${field('Icon', `<input name="icon" value="${esc(plugin.icon || 'plug')}" placeholder="plug">`)}
    ${field('Source', `<textarea name="source" rows="16" spellcheck="false" required placeholder="exports.activate = async api => { ... }">${esc(plugin.source || '')}</textarea>`)}
    ${field('Server capabilities', `<input name="capabilities" value="${esc((plugin.capabilities || []).join(', '))}" placeholder="graph.read, library.write" autocomplete="off" spellcheck="false"><span class="field-help">Comma separated. Leave empty for read-only access. Writes, runs, secrets and network hosts must each be named: <code>graph.write</code>, <code>run.start</code>, <code>collections.write</code>, <code>secrets.use:my-key</code>, <code>net.fetch:api.example.com</code>.</span>`)}
    <p class="muted small">The plugin runs in a sandboxed iframe. It reaches the server only through <code>api.request</code>, and it never receives the server token or a secret value.</p>
    <p class="form-error" data-form-error hidden></p>
  </form>`;
}

function installPluginDialog() {
  dialog(
    'Install client plugin',
    `${pluginEditor()}<p class="muted small">Import a <code>.agentsys-plugin.json</code> package to include modules, assets and resource contributions.</p><div class="button-row"><button type="button" data-plugin-import>Import JSON file…</button></div>`,
    async form => {
      try {
        const plugin = await Extensions.install({
          api: PluginManifest.API_VERSION,
          formatVersion: PluginManifest.FORMAT_VERSION,
          id: form.elements.id.value,
          title: form.elements.title.value,
          version: form.elements.version.value,
          description: form.elements.description.value,
          icon: form.elements.icon.value,
          source: form.elements.source.value,
          capabilities: readCapabilities(form),
        });
        await reloadPlugins();
        toast('Plugin installed in this browser.');
        await go('/plugins/' + encodeURIComponent(plugin.id));
      } catch (error) {
        const output = $('[data-form-error]', form);
        output.hidden = false;
        output.textContent = error.message;
        return false;
      }
    },
    'Install'
  );
  $('[data-plugin-import]', $('#modal'))?.addEventListener('click', async () => {
    const [file] = await pickFiles({multiple: false});
    if (!file) return;
    try {
      const packet = JSON.parse(await file.text());
      reviewPluginPackage(packet, file.name, async () => {
        const plugin = await Extensions.install(packet, {approveCapabilities: true});
        await reloadPlugins();
        await go('/plugins/' + encodeURIComponent(plugin.id));
      });
    } catch (error) {
      fail(error);
    }
  });
}

function reviewPluginPackage(packet, source, apply) {
  const record = PluginManifest.normalizePackage(packet);
  const previous = PluginStore.get(record.id);
  const added = record.capabilities.filter(capability => !previous || !PluginCapabilities.allows(previous.capabilities, capability));
  const dangerous = capability => /(?:\.write$|^run\.start$|^net\.fetch:|^secrets\.use:)/.test(capability);
  dialog(previous ? 'Review plugin update' : 'Review plugin installation',
    `<h3>${esc(record.title)} ${esc(record.version)}</h3><p>Author: ${esc(record.author || 'Not specified')}</p><p>Source: ${esc(source)}</p>
      <p>Requested permissions:</p><ul>${record.capabilities.map(capability => `<li${dangerous(capability) ? ' class="form-error"' : ''}>${esc(capability)}${added.includes(capability) ? ' (new)' : ''}</li>`).join('')}</ul>
      <p>Write permissions can change server data. Run, network and secret permissions can execute graphs and contact the named services. Cancel keeps the installed version and its permissions.</p>`,
    async () => { await apply(); return true; }, previous ? 'Approve update' : 'Install');
}

function exportPlugin(id) {
  const plugin = PluginStore.get(id);
  if (!plugin) return;
  downloadJSON(PluginStore.export(id), `${plugin.id}-${plugin.version}.agentsys-plugin`);
}

function updatePluginDialog(plugin) {
  dialog(
    'Update plugin package',
    `<p class="muted">Install a newer package with the id <code>${esc(plugin.id)}</code>. The update keeps the plugin's stored data and its enabled state. If the new package cannot start, the previous one is restored.</p>
     <div class="button-row"><button type="button" data-plugin-update-file>Choose package file…</button></div>
     <p class="form-error" data-form-error hidden></p>`,
    null,
    'Close'
  );
  $('[data-plugin-update-file]', $('#modal'))?.addEventListener('click', async () => {
    const [file] = await pickFiles({multiple: false});
    if (!file) return;
    try {
      const packet = JSON.parse(await file.text());
      if ((packet.manifest?.id || packet.id) !== plugin.id)
        throw new Error(`This package is for ${packet.manifest?.id || packet.id}, not ${plugin.id}.`);
      reviewPluginPackage(packet, file.name, async () => {
        const updated = await Extensions.update(plugin.id, packet, {approveCapabilities: true});
        await reloadPlugins();
        toast(`Updated to ${updated.version}.`);
        await render();
      });
    } catch (error) {
      const output = $('[data-form-error]', $('#modal'));
      if (output) {
        output.hidden = false;
        output.textContent = error.message;
      } else fail(error);
    }
  });
}

async function deployPlugin(plugin, confirmed = false) {
  if (!plugin.enabled) {
    toast('Turn the plugin on before deploying its resources.', true);
    return;
  }
  if (!confirmed) {
    const plan = await Extensions.deploymentPlan(plugin.id);
    dialog('Deployment plan', `<p>Active server: ${esc(Environment.active()?.name || '')}. Operations are saved separately; retrying resumes missing resources.</p>
      <ul>${plan.actions.map(item => `<li>${esc(item.action)}: ${esc(item.kind)} ${esc(item.name)} ${esc(item.reason || '')}</li>`).join('')}</ul>
      <p>Required permissions: ${esc(plan.permissions.join(', '))}</p><p class="form-error" data-form-error hidden></p>`,
    async () => { await deployPlugin(plugin, true); return true; }, 'Deploy');
    return;
  }
  const result = await Extensions.deploy(plugin.id);
  await Promise.all([loadLibrary().catch(() => {}), loadProjects().catch(() => {})]);
  if (!result.ok) {
    const warning = result.warnings?.[0]?.message;
    fail(new Error(result.errors[0]?.message + (warning ? ' ' + warning : '')));
  } else {
    toast(
      `Deployed ${result.summary.library} Library node(s), ${result.summary.collections} collection(s), ${result.summary.workflows} workflow template(s).`
    );
  }
  await render();
}

async function pluginPage(view, route) {
  await loadPlugins();
  const plugin = PluginStore.get(route.id);
  if (!plugin) throw new ApiError('not_found', 'Plugin not found', 404);
  if (app.route !== route) return;
  const uiError = Extensions.errorOf(plugin.id);
  const state = uiError ? ['failed', 'Interface failed'] : plugin.enabled ? ['running', 'Running'] : ['off', 'Off'];
  const dependencies = PluginStore.dependencyState(plugin.id);
  const deployment = Extensions.deploymentOf(plugin.id);
  const contributes = plugin.contributes || {collections: [], library: [], workflows: []};
  const declared = contributes.collections.length + contributes.library.length + contributes.workflows.length;
  view.innerHTML = `<div class="page form-page plugin-page">
    ${pageHead({title: esc(plugin.title), glyph: plugin.icon || 'plug', sub: esc(plugin.description || ''), actions: `<button type="button" class="${plugin.enabled ? '' : 'primary'}" data-plugin-toggle>${plugin.enabled ? 'Turn off' : 'Turn on'}</button><button type="button" class="icon" data-plugin-reload title="Reload plugins" aria-label="Reload plugins">${icon('refresh')}</button>`})}
    ${uiError ? `<p class="form-error plugin-error">${esc(uiError)}</p><p><button type="button" data-plugin-recover>Try again</button></p>` : ''}
    ${dependencies.ok ? '' : `<p class="form-error plugin-error">${esc(dependencies.errors.map(item => item.message).join(' '))}</p>`}
    <section><h2>Information</h2><dl class="page-facts">
      <div><dt>State</dt><dd><span class="plugin-state ${state[0]}">${state[1]}</span></dd></div>
      <div><dt>Version</dt><dd>${esc(plugin.version)}</dd></div>
      <div><dt>Plugin API</dt><dd>${plugin.api}</dd></div>
      <div><dt>Package</dt><dd>Format ${plugin.formatVersion}${plugin.hasModules ? ' · modules' : ''}${plugin.assetCount ? ` · ${plugin.assetCount} asset(s)` : ''}</dd></div>
      <div><dt>Runs in</dt><dd>This browser · sandboxed iframe</dd></div>
      <div><dt>Server access</dt><dd>${esc(typeof PluginCapabilities === 'undefined' ? '' : PluginCapabilities.describe(plugin.capabilities))}</dd></div>
      <div><dt>Dependencies</dt><dd>${esc(dependencyText(plugin))}</dd></div>
      <div><dt>Source</dt><dd>Installed here</dd></div>
      ${plugin.author ? `<div><dt>Author</dt><dd>${esc(plugin.author)}</dd></div>` : ''}
      ${plugin.license ? `<div><dt>License</dt><dd>${esc(plugin.license)}</dd></div>` : ''}
      ${plugin.homepage ? `<div><dt>Homepage</dt><dd>${/^https?:\/\//.test(plugin.homepage) ? `<a href="${esc(plugin.homepage)}" target="_blank" rel="noopener noreferrer">${esc(plugin.homepage)}</a>` : esc(plugin.homepage)}</dd></div>` : ''}
    </dl></section>
    <section><h2>Server resources</h2>
      <p class="muted">Installing the package changed this browser only. Deploying creates ordinary server data through the plugin's capabilities: ${contributes.collections.length} collection definition(s), ${contributes.library.length} Library node(s), ${contributes.workflows.length} workflow template(s). Anything already on the server is updated in place; records and user data are never deleted.</p>
      <dl class="page-facts">
        <div><dt>Declared</dt><dd>${declared || 'Nothing'}</dd></div>
        <div><dt>Deployed here</dt><dd>${deployment.deployed ? `${deployment.counts.library} node(s), ${deployment.counts.collections} collection(s), ${deployment.counts.workflows} template(s)` : 'Not deployed'}</dd></div>
        ${deployment.pluginVersion ? `<div><dt>Deployed version</dt><dd>${esc(deployment.pluginVersion)}</dd></div>` : ''}
      </dl>
      ${declared ? `<div class="button-row"><button type="button" class="primary" data-plugin-deploy ${plugin.enabled ? '' : 'disabled'}>Deploy resources</button></div>` : ''}
      <p class="muted small">The deployment record belongs to this environment. Switching servers and deploying again creates resources on the other server; it never reuses an identifier from this one.</p>
    </section>
    <section><h2>Interface</h2>${pluginInterface(plugin)}</section>
    <section><h2>Package</h2>${pluginEditor(plugin)}<div class="button-row"><button type="button" data-plugin-save>Save changes</button><button type="button" data-plugin-export>Export package</button><button type="button" data-plugin-update>Update from file…</button><button type="button" class="danger" data-plugin-remove>Remove plugin…</button></div></section>
    <section><h2>What the server sees</h2>
      <p class="muted">The server never loads this plugin. Anything it creates through the API — a Library node, a workflow, a collection record — is ordinary server data and keeps working when this client is closed. A plugin is a convenience for editing and running those resources, not a requirement for them.</p>
    </section>
  </div>`;
  $('[data-plugin-toggle]', view).onclick = () =>
    setPluginEnabled(plugin.id, !plugin.enabled).then(() => go('/plugins/' + encodeURIComponent(plugin.id), true)).catch(fail);
  $('[data-plugin-reload]', view).onclick = () => reloadPlugins().then(() => go('/plugins', true)).catch(fail);
  $('[data-plugin-recover]', view).onclick = () => Extensions.recover(plugin.id).then(() => render()).catch(fail);
  $('[data-plugin-deploy]', view).onclick = () => deployPlugin(plugin).catch(fail);
  $('[data-plugin-update]', view).onclick = () => updatePluginDialog(plugin);
  $('[data-plugin-save]', view).onclick = () => {
    const form = $('#plugin-editor', view);
    try {
      const record = PluginStore.record(plugin.id);
      const changed = {
        ...record,
        title: form.elements.title.value,
        version: form.elements.version.value,
        description: form.elements.description.value,
        icon: form.elements.icon.value,
        source: form.elements.source.value,
        capabilities: readCapabilities(form),
      };
      return reviewPluginPackage(changed, 'Local editor', async () => {
        await Extensions.update(plugin.id, changed, {approveCapabilities: true});
        toast('Plugin saved.');
        await go('/plugins/' + encodeURIComponent(plugin.id), true);
      });
    } catch (error) {
      fail(error);
    }
  };
  $('[data-plugin-export]', view).onclick = () => exportPlugin(plugin.id);
  $('[data-plugin-remove]', view).onclick = () => removePlugin(plugin);
}

PAGES.plugins = async (view, route) => {
  if (route.id) return pluginPage(view, route).catch(error => notFoundPlugin(view, error));
  await loadPlugins();
  if (app.route !== route) return;
  view.innerHTML = `<div class="page">${pageHead({title: 'Plugins'})}<div class="cards">${app.plugins
    .map(pluginCard)
    .join('')}</div>${
    app.plugins.length ? '' : '<div class="empty small"><h2>No client plugins</h2></div>'
  }</div>`;
};

const notFoundPlugin = (view, error) => {
  view.innerHTML = `<div class="page">${pageHead({title: 'Plugin not found', sub: esc(error.message), menu: ''})}<p><a class="button" href="/plugins" data-link>Back to Plugins</a></p></div>`;
};

// ---- ext ----
// A page a plugin registered (js/plugin-host.js): its own render(container, context) draws the body.

PAGES.ext = async (view, route) => {
  const page = typeof Extensions === 'undefined' ? null : Extensions.page(route.plugin, route.id);
  if (!page) {
    view.innerHTML = `<div class="page">${pageHead({title: 'Page not found', sub: 'The plugin is not loaded or the page is gone.', menu: ''})}<p><a class="button" href="/plugins" data-link>Back to Plugins</a></p></div>`;
    return;
  }
  const menu = Extensions.hasMenu(`ext:${route.plugin}:${route.id}`) ? `ext:${route.plugin}:${route.id}` : '';
  view.innerHTML = `<div class="page ext-page">${pageHead({
    title: esc(page.title),
    sub: esc(page.description || ''),
    glyph: page.icon || 'plug',
    menu,
  })}<div class="page-body ext-body" id="ext-page-body"></div></div>`;
  const body = $('#ext-page-body', view);
  try {
    const result = await page.render(body, {
      page,
      route,
      api: Extensions.apiOf(route.plugin),
      go: path => go(path),
      refresh: () => render(),
    });
    if (app.route !== route) {
      if (typeof result === 'function') result();
      return;
    }
    if (typeof result === 'function') app.pageDispose = result;
    else if (typeof result === 'string' && !body.childNodes.length) body.innerHTML = result;
    else if (result instanceof Node) body.append(result);
  } catch (error) {
    body.innerHTML = `<div class="empty small"><h2>The plugin page could not be drawn</h2><p>${esc(error.message)}</p></div>`;
    fail(error);
  }
};

// ---- library ----
// The Library page: Custom Nodes and the groups they are kept in, as cards. A node opens as a graph in its own editor.

/** Opens the graph editor for a Custom Node: an existing one, or a new one when no id is given. */
async function openNodeEditor(resourceId = null, folder = '', replace = false) {
  const origin = app.route;
  const opened = await api('library/node-editor', {method: 'POST', body: {resource_id: resourceId, folder}});
  if (app.route !== origin) return;
  await go(`/p/${opened.project_id}/w/${opened.workflow_id}`, replace);
}

// ----- the actions behind every "⋯", "+" and drag: on rows of the second panel and on cards alike -----
const refreshLibrary = async () => {
  if (!(await leaveView())) return;
  await loadLibrary();
  await render();
};
const newNode = (folder = '') => openNodeEditor(null, folder).catch(fail);
const folderCall = body => api('library/node-folders', {method: 'POST', body});
const moveNode = (id, folder) =>
  api(`library/custom-nodes/${id}/move`, {method: 'POST', body: {folder}}).then(refreshLibrary).catch(fail);
function askGroupName(title, label, value, save) {
  dialog(
    title,
    field('Name', `<input name="name" required maxlength="100" autofocus value="${esc(value)}">`),
    form => save(form.name.value.trim()),
    label
  );
  $('#modal input[name=name]').select();
}
const newGroup = parent =>
  askGroupName('New group', 'Create', '', name =>
    folderCall({action: 'create', path: parent, name}).then(refreshLibrary)
  );

/** Menus of the groups one can move a Custom Node to, nested like the groups. */
function moveMenu(parent, item) {
  return app.nodeFolders
    .filter(f => parentPath(f) === parent)
    .map(f => {
      const here = [baseName(f), () => moveNode(item.id, f), {icon: 'folder', disabled: item.payload.folder === f}],
        inner = moveMenu(f, item);
      return inner.length
        ? [here[0], here[1], {...here[2], children: [[`${baseName(f)} (here)`, ...here.slice(1)], null, ...inner]}]
        : here;
    });
}
/** Whether the open page is (or is inside) what is about to go: it must leave first. */
const showsAny = (items, path) =>
  (path !== undefined && app.route.folder !== undefined && underPath(app.route.folder, path)) ||
  items.some(r => r.id === app.route.id || app.route.project === 'lib-' + r.id);

async function duplicateResource(item) {
  const copy = await api(`library/custom-nodes/${item.id}/duplicate`, {method: 'POST', body: {}});
  await loadLibrary();
  await go(resourceHref(copy));
}
const deleteResource = item =>
  confirmDialog(
    'Delete from library?',
    `“${item.name}” will be removed. Copies already placed on canvases keep working.`,
    async () => {
      await api(`resources/${item.id}`, {method: 'DELETE'});
      Tabs.dropProject('lib-' + item.id);
      if (showsAny([item])) await go(NODES_PATH, true);
      else await refreshLibrary();
    },
    'Delete'
  );

/** The icon of a Custom Node (the same choice as in the Properties of its main group). */
const changeNodeIcon = item =>
  dialog(
    'Node icon',
    field('Icon', iconGrid(item.payload.icon, 'complex')),
    async form => {
      const icon = form.icon.value;
      await api(`resources/${item.id}`, {method: 'PUT', body: {name: item.name, payload: {...item.payload, icon}}});
      Tabs.setIcon('lib-' + item.id, icon);
      await refreshLibrary();
    },
    'Save'
  );

/** Menu of a Custom Node. */
function resourceActions(item, title = () => menuTitle('resource:' + item?.id)) {
  if (!item) return;
  return [
    ...(developerMode()
      ? [
          ['Edit graph', () => openNodeEditor(item.id).catch(fail), {icon: 'pencil'}],
          [
            'Rename',
            () =>
              inlineRename(title, item.name, async name => {
                await api(`resources/${item.id}`, {method: 'PUT', body: {name, payload: item.payload}});
                Tabs.rename('lib-' + item.id, name);
                await refreshLibrary();
              }),
            {icon: 'pencil'},
          ],
          ['Change icon', () => changeNodeIcon(item), {icon: 'star'}],
          ['Duplicate', () => duplicateResource(item).catch(fail), {icon: 'copy'}],
          [
            'Move to',
            null,
            {
              icon: 'folder',
              children: [
                ['No group', () => moveNode(item.id, ''), {icon: 'package', disabled: !item.payload.folder}],
                ...(moveMenu('', item).length ? [null, ...moveMenu('', item)] : []),
              ],
            },
          ],
        ]
      : []),
    ['Export', () => exportResources([item], item.name), {icon: 'upload'}],
    ...(developerMode() ? [null, ['Delete', () => deleteResource(item), {icon: 'trash', danger: true}]] : []),
  ];
}
const nodesIn = path => app.resources.filter(r => underPath(r.payload.folder || '', path));
/** Menu of a group of Custom Nodes. */
function folderActions(path, title = () => menuTitle('folder:' + path)) {
  const name = baseName(path),
    exportGroup = ['Export group', () => exportResources(nodesIn(path), name), {icon: 'upload'}];
  if (!developerMode()) return [exportGroup];
  return [
    ...creationActions(path),
    [
      'Rename',
      () =>
        inlineRename(title, name, async next => {
          await folderCall({action: 'rename', path, name: next});
          const moved = (parentPath(path) ? parentPath(path) + '/' : '') + next,
            open = app.route.folder;
          if (open !== undefined && underPath(open, path)) await go(folderHref(moved + open.slice(path.length)), true);
          else await refreshLibrary();
        }),
      {icon: 'pencil'},
    ],
    exportGroup,
    [
      'Change icon',
      () =>
        dialog(
          'Group icon',
          field('Icon', iconGrid((app.nodeFolderIcons || {})[path], 'folder')),
          form => folderCall({action: 'icon', path, icon: form.icon.value}).then(refreshLibrary),
          'Save'
        ),
      {icon: 'star'},
    ],
    null,
    [
      'Delete group',
      () => {
        const inside = nodesIn(path),
          groups = app.nodeFolders.filter(f => f !== path && underPath(f, path)).length;
        confirmDialog(
          'Delete group and contents?',
          `“${name}” is removed with everything in it: ${plural(groups, 'group')} and ${plural(inside.length, 'Custom Node')}. This cannot be undone.`,
          async () => {
            const leave = showsAny(inside, path);
            await folderCall({action: 'delete', path});
            for (const r of inside) Tabs.dropProject('lib-' + r.id);
            if (leave) await go(parentPath(path) ? folderHref(parentPath(path)) : NODES_PATH, true);
            else await refreshLibrary();
          },
          'Delete'
        );
      },
      {icon: 'trash', danger: true},
    ],
  ];
}
/** New node and New group, first in the menu of the Library and of a group. */
const creationActions = folder =>
  developerMode()
    ? [
        ['New node', () => newNode(folder), {icon: 'plus'}],
        ['New group', () => newGroup(folder), {icon: 'folder'}],
        null,
      ]
    : [];
/** Menu of the Library itself, and the "+" of its second panel. */
const nodesActions = (includeCreation = true) => [
  ...(includeCreation ? creationActions('') : []),
  ['Import…', () => importFiles(), {icon: 'download'}],
  ['Export all', () => exportResources(app.resources, 'Library'), {icon: 'upload', disabled: !app.resources.length}],
  null,
  ['Restore built-in nodes', () => restoreBuiltin().catch(fail), {icon: 'package'}],
];
async function restoreBuiltin() {
  const result = await api('library/builtin', {method: 'POST', body: {restore: true}});
  await refreshLibrary();
  toast(
    result.added.length
      ? `${plural(result.added.length, 'built-in node')} restored.`
      : 'All built-in nodes are in the Library.'
  );
}
async function importFiles() {
  const files = await pickFiles({accept: '.json,application/json'});
  if (!files.length) return;
  try {
    const made = await importResources(files);
    toast(`${plural(made.length, 'node')} imported.`);
    await loadLibrary();
    await go(made.length === 1 && developerMode() ? resourceHref(made[0]) : NODES_PATH, true);
  } catch (error) {
    fail(error);
  }
}

// Drag a Custom Node (a row of the second panel or a card) onto a group, or onto "Library" itself, to move it there.
const clearDrop = () => $$('.drop-over').forEach(e => e.classList.remove('drop-over'));
document.addEventListener('dragstart', event => {
  const node = event.target.closest?.('[data-drag]');
  if (!node) return;
  event.dataTransfer.setData('text/plain', node.dataset.drag);
  event.dataTransfer.effectAllowed = 'move';
});
document.addEventListener('dragover', event => {
  const spot = event.target.closest?.('[data-drop-folder]');
  if (!spot || !developerMode()) return;
  event.preventDefault();
  clearDrop();
  spot.classList.add('drop-over');
});
document.addEventListener('dragleave', event => event.relatedTarget || clearDrop());
document.addEventListener('dragend', clearDrop);
document.addEventListener('drop', event => {
  const spot = event.target.closest?.('[data-drop-folder]'),
    id = event.dataTransfer.getData('text/plain');
  clearDrop();
  if (!spot || !developerMode() || !app.resources.some(r => r.id === id)) return;
  event.preventDefault();
  moveNode(id, spot.dataset.dropFolder);
});

// ----- import / export -----
/** Saves Custom Nodes as one JSON file (a single node is saved as an object, several as a list). */
function exportResources(items, name) {
  const entries = items.map(r => ({
    name: r.name,
    payload: r.payload,
  }));
  const text = JSON.stringify(TextGraph.encode(entries.length === 1 ? entries[0] : entries), null, 2);
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([text], {type: 'application/json'}));
  link.download = `${name.replace(/[^\w\-. ]+/g, '_').trim() || 'library'}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

/** Adds exported nodes. A name already taken gets a number. Returns the nodes made. */
async function addEntries(entries, source) {
  const made = [],
    taken = new Set((await api('resources')).map(r => r.name)); // kept in step as nodes are added
  for (const entry of entries) {
    if (!entry || typeof entry.name !== 'string' || !entry.payload || typeof entry.payload !== 'object')
      throw new Error(`${source} is not an exported Custom Node.`);
    const base = entry.name.trim().slice(0, 100) || 'Imported';
    let name = base,
      n = 1;
    while (taken.has(name)) name = `${base} ${++n}`;
    taken.add(name);
    // A node keeps its group, so the tree comes back as it was exported.
    const payload = entry.payload;
    const saved = await api('resources', {method: 'POST', body: {name, payload}});
    // The main group of a node carries its name; PUT keeps that in step.
    await api(`resources/${saved.id}`, {method: 'PUT', body: {name, payload: saved.payload}});
    made.push(saved);
  }
  return made;
}

/** Reads JSON files and adds their nodes to the Library. */
async function importResources(files) {
  const made = [];
  for (const file of files) {
    let data;
    try {
      data = TextGraph.decode(JSON.parse(await file.text()));
    } catch (error) {
      throw new Error(`${file.name}: ${error.message || 'invalid Library file'}`);
    }
    made.push(...(await addEntries(Array.isArray(data) ? data : [data], file.name)));
  }
  return made;
}

// ----- pages -----
/** A well listing what is inside (first rows, then a count of the rest). */
const cardList = rows =>
  rows.length
    ? `<ul>${rows
        .slice(0, 4)
        .map(([glyph, name]) => `<li>${icon(glyph)}<span>${esc(name)}</span></li>`)
        .join('')}${rows.length > 4 ? `<li class="more">+${rows.length - 4} more</li>` : ''}</ul>`
    : '<span class="preview-empty">Nothing here yet</span>';
const itemCard = r =>
  card({
    href: developerMode() ? resourceHref(r) : null,
    glyph: resourceIcon(r),
    title: r.name,
    preview: `<div class="preview-layer">${previewSVG(graphFromBundle(r.payload.bundle))}</div>`,
    attrs: `title="${esc(r.payload.description || '')}"`,
    menu: 'resource:' + r.id,
    tint: 'k-complex',
    extra: developerMode() ? `draggable="true" data-drag="${esc(r.id)}"` : '',
  });
const folderCard = (path, rows) => {
  const groups = app.nodeFolders.filter(f => f !== path && underPath(f, path)).length;
  return card({
    href: folderHref(path),
    glyph: (app.nodeFolderIcons || {})[path] || 'folder',
    title: baseName(path),
    preview: cardList(rows),
    previewClass: 'card-note',
    facts: groups ? plural(groups, 'group') : '',
    menu: 'folder:' + path,
    extra: developerMode() ? `data-drop-folder="${esc(path)}"` : '',
  });
};
const notFound = (what, href, back) =>
  `${pageHead({title: `${esc(what)} not found`, menu: ''})}<p><a class="button" href="${esc(href)}" data-link>${esc(back)}</a></p>`;

/** The Library: its sections as cards (one: Nodes). */
function libraryOverview(view) {
  const rows = [
    ...app.nodeFolders.filter(f => !parentPath(f)).map(f => [(app.nodeFolderIcons || {})[f] || 'folder', baseName(f)]),
    ...app.resources.filter(r => !r.payload.folder).map(r => [resourceIcon(r), r.name]),
  ];
  view.innerHTML = `<div class="page">${pageHead({title: 'Library', sub: 'Reusable resources.'})}<div class="cards">${card(
    {
      href: NODES_PATH,
      glyph: 'complex',
      title: 'Nodes',
      preview: cardList(rows),
      previewClass: 'card-note',
      attrs: 'title="Reusable Custom Nodes"',
      menu: 'nodes:',
    }
  )}${(app.librarySections || []).map(s => card({href: '/library/' + s.id, glyph: s.icon || 'plug', title: s.title, menu: 'collection:' + s.id, attrs: `title="${esc(s.description || '')}"`})).join('')}${(typeof Extensions === 'undefined' ? [] : Extensions.librarySections()).map(s => card({href: s.href, glyph: s.icon || 'database', title: s.title, preview: `<span class="muted">${esc(s.description || 'Added by ' + s.plugin)}</span>`, previewClass: 'card-note', attrs: `title="${esc(s.description || '')}"`})).join('')}</div></div>`;
}

/** The Nodes section, or one group of it: its groups and nodes as cards. */
function libraryList(view, route) {
  const folder = route.folder || '',
    folders = app.nodeFolders.filter(f => parentPath(f) === folder),
    items = app.resources.filter(r => (r.payload.folder || '') === folder);
  if (folder && !app.nodeFolders.includes(folder))
    return void (view.innerHTML = `<div class="page">${notFound('Group', NODES_PATH, 'Back to Nodes')}</div>`);
  const content = path =>
    app.resources.filter(r => (r.payload.folder || '') === path).map(r => [resourceIcon(r), r.name]);
  const spec = folder ? 'folder:' + folder : 'nodes:';
  view.innerHTML = `<div class="page">${pageHead({
    title: esc(folder ? baseName(folder) : 'Nodes'),
    sub: folder ? '' : 'Reusable Custom Nodes.',
    menu: spec,
  })}
    <div class="cards">${folders
      .map(f =>
        folderCard(f, [
          ...app.nodeFolders
            .filter(g => parentPath(g) === f)
            .map(g => [(app.nodeFolderIcons || {})[g] || 'folder', baseName(g)]),
          ...content(f),
        ])
      )
      .join('')}${items.map(itemCard).join('')}</div>
    ${folders.length || items.length ? '' : '<div class="empty small"><h2>No nodes here yet</h2></div>'}</div>`;
}

PAGES.resources = async (view, route) => {
  await loadLibrary();
  if (app.route !== route) return;
  if (!route.section) return libraryOverview(view);
  if (route.section !== 'nodes') return pluginLibrarySection(view, route);
  if (!route.id) return libraryList(view, route);
  if (!developerMode() || !app.resources.some(r => r.id === route.id)) return go('/library', true);
  await openNodeEditor(route.id, '', true).catch(fail); // a node opens as a graph
};

/** Plugin-owned collections share Library navigation and the application's form controls. */
async function pluginLibrarySection(view, route) {
  const section = (app.librarySections || []).find(s => s.id === route.section);
  if (!section || route.id) {
    view.innerHTML = `<div class="page">${notFound('Section', '/library', 'Back to Library')}</div>`;
    return;
  }
  const endpoint = `plugins/${encodeURIComponent(section.plugin)}/${encodeURIComponent(section.route)}`;
  const items = await api(endpoint);
  if (app.route !== route) return;
  const edit = (item = {}) =>
    dialog(
      item.id ? 'Edit provider' : 'New provider',
      section.fields
        .map(f =>
          field(
            f.label,
            `<input name="${esc(f.key)}" type="${f.type === 'password' ? 'password' : 'text'}" ${f.required ? 'required' : ''} value="${esc(item[f.key] || '')}" ${f.type === 'password' ? 'autocomplete="new-password" title="Leave empty to keep saved key"' : ''}>`
          )
        )
        .join(''),
      async form => {
        await api(endpoint, {
          method: item.id ? 'PUT' : 'POST',
          body: {
            id: item.id,
            ...Object.fromEntries(section.fields.map(f => [f.key, form.elements.namedItem(f.key).value])),
          },
        });
        await pluginLibrarySection(view, route);
      },
      'Save'
    );
  const remove = item =>
    confirmDialog(
      'Delete provider?',
      `Remove ${item.providerId}?`,
      async () => {
        await api(endpoint, {method: 'DELETE', query: {id: item.id}});
        await pluginLibrarySection(view, route);
      },
      'Delete'
    );
  app.libraryCollection = {section: section.id, items, edit, remove};
  view.innerHTML = `<div class="page">${pageHead({title: esc(section.title), sub: esc(section.description || ''), menu: 'collection:' + section.id})}
    <div class="cards">${items
      .map(item =>
        card({
          glyph: section.icon || 'plug',
          title: item.name || item.providerId,
          facts: esc(item.providerId),
          menu: 'provider:' + item.id,
          previewClass: 'card-note',
          preview: cardList([['server', item.baseURL], ...(item.model ? [['sparkles', item.model]] : [])]),
        })
      )
      .join('')}</div>
    ${items.length ? '' : '<div class="empty small"><h2>No providers yet</h2></div>'}</div>`;
}

function collectionActions(section) {
  if (!(app.librarySections || []).some(item => item.id === section)) return [];
  return [
    [
      'New provider',
      async () => {
        if (app.libraryCollection?.section !== section || app.route?.section !== section)
          await go('/library/' + section);
        app.libraryCollection.edit();
      },
      {icon: 'plus'},
    ],
  ];
}
function providerActions(id) {
  const collection = app.libraryCollection;
  if (!collection || collection.section !== app.route?.section) return [];
  const item = collection.items.find(item => item.id === id);
  return item
    ? [
        ['Edit', () => collection.edit(item), {icon: 'pencil'}],
        null,
        ['Delete', () => collection.remove(item), {icon: 'trash', danger: true}],
      ]
    : [];
}

// ---- api ----
// The API reference: a searchable method tree beside the selected method, inside the page.

/** Stable addresses and a path tree for the searchable reference. */
const apiCallKey = row => row.method + ' ' + row.path;
const apiCallHref = row => '/api?call=' + encodeURIComponent(apiCallKey(row));
const apiReferenceRows = spec =>
  Object.entries(spec.paths).flatMap(([path, methods]) =>
    Object.entries(methods)
      .filter(([method]) => ['get', 'post', 'put', 'patch', 'delete'].includes(method))
      .map(([method, op]) => ({path, method, op}))
  );
function apiPathTree(rows) {
  const root = {children: new Map(), calls: []};
  rows.forEach(row => {
    let level = root,
      path = '';
    for (const segment of row.path.replace(/^\/api\//, '').split('/')) {
      path += '/' + segment;
      if (!level.children.has(segment)) level.children.set(segment, {segment, path, children: new Map(), calls: []});
      level = level.children.get(segment);
    }
    level.calls.push(row);
  });
  return root;
}
/** Keep method navigation on the page so folding the application sidebar never hides it. */
function mountApiReference(box, spec) {
  const responseObject = value => value.$ref?.startsWith('#/components/responses/') ? spec.components.responses[value.$ref.split('/').at(-1)] : value;
  const rows = apiReferenceRows(spec),
    state = Tabs.stateOf('api'),
    open = new Set(state.apiOpen ?? []);
  box.innerHTML = `<nav class="api-navigation" aria-label="API methods"><label class="api-search"><span>Search methods</span><input id="api-method-search" type="search" placeholder="Search" title="Search by HTTP method, path or description" aria-label="Search API methods"></label><span class="muted small" data-api-count role="status"></span><div class="api-call-tree"></div></nav><article class="api-method" aria-live="polite"></article>`;
  const detail = $('.api-method', box),
    tree = $('.api-call-tree', box),
    search = $('#api-method-search', box);
  let selected = rows.findIndex(row => apiCallKey(row) === routeQuery().get('call'));
  if (selected < 0) selected = 0;
  const reveal = row => {
    let path = '';
    for (const segment of row.path.replace(/^\/api\//, '').split('/')) {
      path += '/' + segment;
      open.add(path);
    }
  };
  const drawTree = () => {
    const scroll = tree.scrollTop;
    const query = search.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean),
      filtered = rows.filter(row =>
        query.every(q => `${row.method} ${row.path} ${row.op.summary}`.toLocaleLowerCase().includes(q))
      );
    const branch = level =>
      (level.calls.length
        ? '<div class="api-calls">' +
          level.calls
            .map(row => {
              const index = rows.indexOf(row);
              return `<a class="api-call" title="${esc(row.method.toUpperCase() + ' ' + row.path + ' - ' + row.op.summary)}" href="${esc(urlOf(apiCallHref(row)))}" data-api-call="${index}" ${index === selected ? 'aria-current="page"' : ''}><span class="method m-${row.method}">${row.method.toUpperCase()}</span></a>`;
            })
            .join('') +
          '</div>'
        : '') +
      [...level.children.values()]
        .map(
          child =>
            `<details data-api-path="${esc(child.path)}" ${query.length || open.has(child.path) ? 'open' : ''}><summary title="${esc('/api' + child.path)}"><code>${esc(child.segment)}</code></summary><div>${branch(child)}</div></details>`
        )
        .join('');
    tree.innerHTML = filtered.length ? branch(apiPathTree(filtered)) : '<p class="muted">No matching methods.</p>';
    tree.scrollTop = scroll;
    $('[data-api-count]', box).textContent = `${filtered.length} of ${rows.length} methods`;
  };
  const select = index => {
    const {path, method, op} = rows[index];
    detail.innerHTML = `<div class="api-method-heading"><span class="method m-${method}">${method.toUpperCase()}</span><code>${esc(path)}</code></div><h3>${esc(op.summary)}</h3>${op.description ? `<p class="muted">${esc(op.description)}</p>` : ''}
      <pre class="code">await agentsys('${method.toUpperCase()}', '${esc(path.replace(/^\/api\//, ''))}'${op.requestBody ? ', body' : ''})</pre>
      ${op.parameters?.length ? `<div class="table-scroll"><table><thead><tr><th>Name</th><th>Location</th><th>Type</th><th>Description</th></tr></thead><tbody>${op.parameters.map(p => `<tr><td><code>${esc(p.name)}</code>${p.required ? ' *' : ''}</td><td>${esc(p.in)}</td><td>${esc(p.schema?.type || '')}</td><td>${esc(p.description || '')}</td></tr>`).join('')}</tbody></table></div>` : ''}
      ${op.requestBody ? `<h3>Request body</h3><pre class="code">${esc(pretty(op.requestBody.content?.['application/json']?.example || op.requestBody))}</pre>` : ''}
      <h3>Responses</h3><ul class="api-responses">${Object.entries(op.responses || {})
        .map(([status, response]) => `<li><code>${esc(status)}</code><span>${esc(responseObject(response).description)}</span></li>`)
        .join('')}</ul>`;
  };
  search.value = state.apiFilter ?? '';
  search.oninput = () => {
    state.apiFilter = search.value;
    Tabs.save();
    drawTree();
    tree.scrollTop = 0;
  };
  tree.addEventListener(
    'toggle',
    event => {
      const group = event.target;
      if (!group.matches('details[data-api-path]') || search.value.trim()) return;
      group.open ? open.add(group.dataset.apiPath) : open.delete(group.dataset.apiPath);
      state.apiOpen = [...open];
      Tabs.save();
    },
    true
  );
  tree.onclick = event => {
    const link = event.target.closest('[data-api-call]');
    if (!link || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button) return;
    event.preventDefault();
    selected = Number(link.dataset.apiCall);
    reveal(rows[selected]);
    select(selected);
    drawTree();
    $('[data-api-call="' + selected + '"]', tree)?.focus({preventScroll: true});
    const href = urlOf(apiCallHref(rows[selected]));
    if (href !== routeURL()) history.pushState({}, '', href);
    app.currentURL = routeURL();
  };
  if (rows.length) {
    reveal(rows[selected]);
    select(selected);
  }
  drawTree();
  $('[aria-current="page"]', tree)?.scrollIntoView({block: 'nearest'});
  return {
    rows,
    spec,
    download() {
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob([JSON.stringify(spec, null, 2)], {type: 'application/json'}));
      link.download = 'agentsys-openapi.json';
      link.click();
      URL.revokeObjectURL(link.href);
    },
  };
}

PAGES.api = async (view, route) => {
  const spec = await api('openapi.json');
  if (app.route !== route) return;
  view.innerHTML = `<div class="page api-page">${pageHead({title: 'API reference', sub: 'Every action of the app is an API call.', actions: `<button type="button" id="api-download" title="Download OpenAPI" aria-label="Download OpenAPI">${icon('download')}<span>Download OpenAPI</span></button>`})}
    <section id="api-reference"><div id="api-box"></div></section></div>`;
  const reference = mountApiReference($('#api-box'), spec);
  app.apiReference = reference;
  $('#api-download', view).onclick = () => reference.download();
};

// ---- home ----
// A compact workspace overview: projects and workflows.
const tile = (label, value, href) =>
  `<a class="tile" href="${esc(href)}" data-link><span class="tile-label">${esc(label)}</span><strong class="tile-value">${esc(value)}</strong></a>`;

const welcomeHTML = () =>
  `<div class="welcome-panel"><span class="muted small">YOUR FIRST WORKFLOW</span><h2 title="Start with a small example: one node starts the workflow, another shows its result. Then make it your own.">Turn an idea into a running workflow</h2><div class="button-row"><button type="button" class="primary" data-example>Open example</button><button type="button" data-new-project>New project</button></div></div>`;
async function openStarterWorkflow() {
  const start = 'record:' + uid(),
    result = 'record:' + uid(),
    doc = emptyDoc();
  doc.nodes = [
    {
      id: start,
      kind: 'function',
      node_type: 'custom',
      label: 'Start',
      status: 'ready',
      config: {
        title: 'Start here',
        op: 'on_run',
        inputs: [],
        outputs: [{id: 'out', name: 'out', type: 'signal'}],
      },
    },
    {
      id: result,
      kind: 'function',
      node_type: 'custom',
      label: 'Result',
      status: 'ready',
      config: {
        title: 'Your first result',
        op: 'script',
        inputs: [
          {id: 'in', name: 'in', type: 'signal'},
          {id: 'script', name: 'script', default: 'node.display("Hello! Your workflow is running.");'},
        ],
        outputs: [],
      },
    },
  ];
  doc.layout = {[start]: {x: 0, y: 0}, [result]: {x: 340, y: 0}};
  doc.port_edges = [{id: uid(), source: start, source_port: 'out', target: result, target_port: 'in'}];
  const project = await api('projects/import', {
    method: 'POST',
    body: TextGraph.encode({
      kind: 'project',
      name: 'Getting started',
      description: 'Choose Run to see a result on the second node.',
      workflows: [{name: 'Hello workflow', document: doc}],
    }),
  });
  await loadProjects();
  await go(`/p/${project.id}/w/${project.workflows[0].id}`);
  toast('Choose Run. The second node will show your first result.');
}
function bindWelcome(root) {
  root.addEventListener('click', async event => {
    const button = event.target.closest('[data-new-project], [data-example]');
    if (!button || button.disabled) return;
    button.disabled = true;
    try {
      await (button.hasAttribute('data-example') ? openStarterWorkflow() : newProjectDialog());
    } catch (error) {
      fail(error);
    } finally {
      button.disabled = false;
    }
  });
}
PAGES.home = async (view, route) => {
  const projects = await api('projects');
  if (app.route !== route) return;
  view.innerHTML =
    '<div class="page dashboard">' + pageHead({title: 'Dashboard'}) + '<div id="dashboard-projects"></div></div>';
  const region = $('#dashboard-projects', view);
  bindWelcome(region);
  const draw = projects => {
    region.innerHTML =
      '<div class="dashboard-metrics">' +
      tile('Projects', projects.length, '/projects') +
      tile(
        'Workflows',
        projects.reduce((n, p) => n + p.workflow_count, 0),
        '/projects'
      ) +
      '</div>' +
      (!projects.length ? welcomeHTML() : '') +
      (projects.length
        ? '<section><div class="section-head"><h2>Projects</h2><a href="/projects" data-link>View all</a></div><ul class="dashboard-projects">' +
          projects
            .slice(0, 5)
            .map(
              p =>
                '<li><a data-link href="/p/' +
                esc(p.id) +
                '">' +
                icon('folder') +
                '<span>' +
                esc(p.name) +
                '</span><small>' +
                plural(p.workflow_count, 'workflow') +
                '</small></a></li>'
            )
            .join('') +
          '</ul></section>'
        : '') +
      '<div id="dashboard-extensions"></div>';
    if (typeof Extensions !== 'undefined') Extensions.renderHome($('#dashboard-extensions', region));
  };
  draw(projects);
  livePage(route, async () => {
    const projects = await api('projects');
    if (app.route === route) draw(projects);
  });
};

// ---- environments ----
// Environments: the servers this client can use, their connection state, and the page where one is added,
// tested, edited or removed. There is exactly one active environment; projects and workflows are never merged.

const environmentStatusText = state => {
  const labels = {
    connected: 'Connected',
    connecting: 'Connecting',
    disconnected: 'Disconnected',
    unauthorized: 'Unauthorized',
    error: 'Connection error',
  };
  return labels[state.status] || state.status;
};

const environmentStatusBadge = (state, envId) => {
  const own = envId === state.environment?.id;
  const status = own ? state.status : 'disconnected';
  return `<span class="environment-status"><span class="env-dot" data-status="${esc(status)}" aria-hidden="true"></span>${
    own ? esc(environmentStatusText(state)) : 'Not connected'
  }</span>`;
};

function environmentForm(env = {}) {
  return `<form id="environment-form" class="stack">
    ${field('Name', `<input name="name" required maxlength="80" value="${esc(env.name || '')}" placeholder="Home server" autocomplete="off">`)}
    ${field('Server address', `<input name="url" required inputmode="url" value="${esc(env.url || displayServerURL())}" placeholder="https://agentsys.example.com" autocomplete="url"><span class="field-help">The base URL of an AgentSys Server. No path, no trailing slash needed.</span>`)}
    ${field('Token', `<input name="token" type="password" value="" autocomplete="off" spellcheck="false" placeholder="${env.id ? 'Leave empty to keep the saved token' : 'Only if the server requires one'}"><span class="field-help">Kept for this tab and server address. Enter a token again when the address changes.</span>`)}
    <p class="form-error" data-form-error hidden></p>
    <div class="button-row"><button type="submit" class="primary">${env.id ? 'Save changes' : 'Add server'}</button><button type="button" data-test>Test connection</button></div>
  </form>`;
}

const displayServerURL = () => Environment.defaultURL();

function showEnvironmentDialog(env, onDone) {
  const editing = !!env;
  dialog(editing ? 'Edit server' : 'Add server', environmentForm(env || {}), async form => {
    const value = {
      ...(env || {}),
      name: form.elements.name.value.trim(),
      url: form.elements.url.value.trim(),
      token: form.elements.token.value,
    };
    try {
      const saved = Environment.save(value);
      toast(editing ? 'Server saved.' : 'Server added.');
      onDone?.(saved);
    } catch (error) {
      const output = $('[data-form-error]', form);
      if (output) {
        output.hidden = false;
        output.textContent = error.message;
      }
      return false;
    }
  }, editing ? 'Save' : 'Add');
}

/** Probe without switching; the answer is shown in the page and in a toast. */
async function testEnvironment(env, output) {
  const set = (text, bad = false) => {
    if (output) {
      output.hidden = false;
      output.className = bad ? 'form-error' : 'muted';
      output.textContent = text;
    }
    toast(text, bad);
  };
  try {
    const meta = await Environment.probe(env);
    set(`Connected to ${meta.server_name || env.url} · AgentSys ${meta.version || '?'} · protocol ${meta.protocol}.`);
  } catch (error) {
    set(error.message, true);
  }
}

/** Actions of the Server section, shared by its sidebar row and its page heading. */
function environmentSectionActions() {
  return [
    ['Add server', () => showEnvironmentDialog(null, () => go('/environments', true).catch(fail)), {icon: 'plus'}],
    null,
    [
      'Reconnect',
      () =>
        Environment.reconnect()
          .then(ok => {
            if (!ok) toast(stateMessage(Environment.status()), true);
          })
          .catch(fail),
      {icon: 'refresh'},
    ],
  ];
}

/** Actions of one server card, opened from its three dots or a right-click on the card. */
function environmentActions(id) {
  const env = Environment.get(id);
  if (!env) return [];
  const active = env.id === Environment.active()?.id;
  return [
    active
      ? [
          'Reconnect',
          () =>
            Environment.reconnect()
              .then(ok => {
                if (!ok) toast(stateMessage(Environment.status()), true);
              })
              .catch(fail),
          {icon: 'refresh'},
        ]
      : ['Use this server', () => chooseEnvironment(env.id).catch(fail), {icon: 'power'}],
    ['Test connection', () => testEnvironment(env, $('[data-env-output]')), {icon: 'activity'}],
    null,
    ['Edit server…', () => showEnvironmentDialog(env, () => go('/environments', true).catch(fail)), {icon: 'settings'}],
    ...(active && Environment.tokenOf(env.id)
      ? [
          [
            'Forget token for this tab',
            async () => {
              await Environment.signOut();
              await go('/environments', true);
            },
            {icon: 'key'},
          ],
        ]
      : []),
    [
      'Remove server…',
      () =>
        confirmDialog(
          'Remove server?',
          `Remove the saved connection “${env.name}”? The server and its data are not touched.`,
          async () => {
            try {
              if (Environment.active()?.id === env.id) {
                const next = Environment.list().find(item => item.id !== env.id);
                await Environment.setActive(next.id);
                if (Environment.active()?.id === env.id) return;
              }
              Environment.remove(env.id);
              await go('/environments', true);
            } catch (error) {
              fail(error);
            }
          },
          'Remove'
        ),
      {icon: 'trash', danger: true, disabled: Environment.list().length <= 1},
    ],
  ];
}

PAGES.environments = async view => {
  const state = Environment.status();
  const list = Environment.list();
  const meta = state.meta;
  view.innerHTML = `<div class="page environments-page">
    ${pageHead({title: 'Servers'})}
    <div class="cards">${list
      .map(env =>
        card({
          glyph: 'server',
          title: env.name,
          extra: `data-env-row="${esc(env.id)}"`,
          preview: `<div class="environment-card-status">${environmentStatusBadge(state, env.id)}${
            env.active ? '<span class="badge" data-tone="info">Active</span>' : ''
          }</div><code class="environment-card-url">${esc(env.url)}</code>`,
          previewClass: 'card-note environment-card',
          facts: env.active
            ? `AgentSys ${esc(meta?.version || '?')} · protocol ${esc(String(meta?.protocol || '?'))}`
            : 'Saved in this browser',
          menu: 'environment:' + env.id,
        })
      )
      .join('')}</div>
  </div>`;
};

// The dialog's Test button works on the values currently typed, before they are saved.
document.addEventListener('click', event => {
  const button = event.target.closest('#modal [data-test]');
  if (!button) return;
  event.preventDefault();
  const form = button.closest('#environment-form');
  const output = $('[data-form-error]', form);
  Environment.probeDraft({
    name: form.elements.name.value || 'Server',
    url: form.elements.url.value,
    token: form.elements.token.value,
  })
    .then(meta => {
      output.hidden = false;
      output.className = 'muted';
      output.textContent = `Connected to ${meta.server_name || form.elements.url.value} · AgentSys ${meta.version || '?'} · protocol ${meta.protocol}.`;
    })
    .catch(error => {
      output.hidden = false;
      output.className = 'form-error';
      output.textContent = error.message;
    });
});
