'use strict';

// ---- interaction ----
// Pointer and keyboard handling: panning, dragging, resizing, marquee, context menu wiring.

// ----- interaction -----
function wireCanvas() {
  const canvas = W.canvas;
  wireCanvasTouch(canvas);
  let spaceHeld = false;
  const setTool = tool => {
    armMarquee(false);
    W.tool = tool;
    canvas.dataset.tool = tool;
    for (const button of $$('[data-canvas-tool]', canvas))
      button.setAttribute('aria-pressed', String(button.dataset.canvasTool === tool));
    updateHints();
  };
  for (const button of $$('[data-canvas-tool]', canvas)) button.onclick = () => setTool(button.dataset.canvasTool);
  setTool('select');
  canvas.addEventListener('pointermove', event => {
    const rect = canvas.getBoundingClientRect();
    if (!event.target.closest('.tool-strip,.map,.canvas-hints')) W.pointer = {x: event.clientX, y: event.clientY};
    canvas.style.setProperty('--cursor-x', (event.clientX - rect.left) + 'px');
    canvas.style.setProperty('--cursor-y', (event.clientY - rect.top) + 'px');
    canvas.classList.add('cursor-inside');
  });
  canvas.addEventListener('pointerleave', () => canvas.classList.remove('cursor-inside'));
  canvas.addEventListener('click', event => {
    const button = event.target.closest('[data-empty-add]');
    if (!button) return;
    const r = button.getBoundingClientRect();
    addMenu(r.left, r.bottom + 4);
  });
  $('#undo').onclick = () => undo(false);
  $('#redo').onclick = () => undo(true);
  $('#start')?.addEventListener('click', () => toggleRun().catch(fail));
  $('#pause')?.addEventListener('click', () => pauseRun().catch(fail));
  $('#zoom-in').onclick = () =>
    zoomAt(
      canvas.getBoundingClientRect().left + canvas.clientWidth / 2,
      canvas.getBoundingClientRect().top + canvas.clientHeight / 2,
      1.2
    );
  $('#zoom-out').onclick = () =>
    zoomAt(
      canvas.getBoundingClientRect().left + canvas.clientWidth / 2,
      canvas.getBoundingClientRect().top + canvas.clientHeight / 2,
      1 / 1.2
    );
  $('#fit').onclick = () => fit();
  $('#map-toggle').onclick = () => setMinimapHidden(!$('.map').classList.contains('collapsed'));
  setMinimapHidden($('.map').classList.contains('collapsed'), false);
  wireHints();
  $('[data-selection-pin]').onclick = () => setPinned(!selectionItems().every(n => n.pinned)).catch(fail);
  $('[data-selection-disable]').onclick = () => toggleDisabled()?.catch(fail);
  $('[data-selection-actions]').onclick = event => {
    const rect = event.currentTarget.getBoundingClientRect();
    popup(rect.left, rect.bottom + 4, selectionMenu());
  };
  $('[data-selection-color]').onclick = event => openColorPicker(event.currentTarget.getBoundingClientRect());
  $('#minimap').onpointerdown = event => {
    if (!W.minimap) return;
    W.mapDrag = {...W.minimap};
    const move = e => {
      const rect = $('#minimap').getBoundingClientRect(),
        view = viewRect();
      setCamera(
        W.minimap.x0 + (e.clientX - rect.left - 4) / W.minimap.scale - view.w / 2,
        W.minimap.y0 + (e.clientY - rect.top - 4) / W.minimap.scale - view.h / 2,
        W.camera.zoom
      );
    };
    move(event);
    drag(event, move, () => {
      W.mapDrag = null;
      drawMinimap();
    });
  };
  canvas.addEventListener(
    'wheel',
    event => {
      if (event.target.closest('.toolbar,.canvas-tools,.canvas-hints')) return;
      if (event.target.closest('textarea,.code-editor,.preview-text') && !event.ctrlKey) return;
      event.preventDefault();
      if (event.ctrlKey || event.deltaMode || (Math.abs(event.deltaY) >= 50 && !event.deltaX))
        zoomAt(event.clientX, event.clientY, Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0015)));
      else
        setCamera(W.camera.x + event.deltaX / W.camera.zoom, W.camera.y + event.deltaY / W.camera.zoom, W.camera.zoom);
    },
    {passive: false}
  );
  // A markdown widget (Note): the text is shown rendered; the textarea is there only while it is being edited.
  const editMarkdown = view => {
    const area = $('.md-edit', view.closest('.md-widget'));
    view.hidden = true;
    area.hidden = false;
    area.focus({preventScroll: true});
  };
  const showMarkdown = area => {
    const view = $('.md-view', area.closest('.md-widget'));
    if (!area.value.trim()) return;
    view.innerHTML = renderMarkdown(area.value);
    view.hidden = false;
    area.hidden = true;
  };
  canvas.addEventListener('focusout', event => event.target.matches?.('.md-edit') && showMarkdown(event.target));
  canvas.addEventListener('keydown', event => {
    if (event.target.matches?.('.md-edit') && event.key === 'Escape') event.target.blur();
    else if (event.target.matches?.('.md-view') && event.key === 'Enter') {
      event.preventDefault();
      editMarkdown(event.target);
    }
  });
  canvas.addEventListener('dblclick', event => {
    const view = event.target.closest('.md-view');
    if (view && !event.target.closest('a')) return editMarkdown(view);
    if (!event.target.closest('.node,.frame,input,textarea')) return;
    const node = event.target.closest('.node'),
      frame = event.target.closest('.frame');
    if (node && !event.target.closest('input,textarea')) Inspector.focus();
    else if (frame && !node && !event.target.closest('input,textarea,button,.sock,[data-resize]')) {
      if (!W.selected.has('frame:' + frame.dataset.frame)) select(['frame:' + frame.dataset.frame]);
      Inspector.focus();
    }
  });
  canvas.addEventListener('contextmenu', event => {
    event.preventDefault();
    if (event.target.closest('.toolbar,.canvas-tools,.canvas-hints')) return;
    const element = event.target.closest('.node'),
      frame = event.target.closest('[data-frame]'),
      edge = event.target.closest('[data-edge]');
    const binding = event.target.closest('[data-binding-group]');
    if (binding)
      return popup(event.clientX, event.clientY, [
        [
          'Disconnect',
          () =>
            bindComplexPort(
              binding.dataset.bindingGroup,
              binding.dataset.bindingDirection,
              binding.dataset.bindingPort,
              null,
              {node_id: binding.dataset.bindingNode, port_id: binding.dataset.bindingInner}
            ),
          {danger: true, icon: 'unlink'},
        ],
      ]);
    W.pointer = {x: event.clientX, y: event.clientY};
    if (edge) {
      if (!W.edges.has(edge.dataset.edge)) selectEdges([edge.dataset.edge]);
      const ids = [...W.edges];
      return popup(event.clientX, event.clientY, [
        ['Add reroute', () => splitEdges(ids), {icon: 'plus'}],
        null,
        ['Disconnect', () => disconnectMany(ids), {danger: true, icon: 'unlink'}],
      ]);
    }
    if (element && !W.selected.has(element.dataset.id)) select([element.dataset.id]);
    if (frame && !element && !W.selected.has('frame:' + frame.dataset.frame)) select(['frame:' + frame.dataset.frame]);
    if (element || frame) return popup(event.clientX, event.clientY, selectionMenu());
    popup(event.clientX, event.clientY, [
      ['Paste', () => paste(), {icon: 'paste', hint: shortcutText('paste'), disabled: !hasClipboard()}],
      ['Add', null, {icon: 'plus', children: addItems(), search: true, searchItems: addItems({all: true})}],
    ]);
  });
  canvas.addEventListener('pointerdown', event => {
    if (event.target.closest('input,textarea,select,button,.map,.toolbar,.canvas-tools,.canvas-hints,.md-view a')) return;
    canvas.focus({preventScroll: true});
    if (W.marqueeArmed && event.button === 0) {
      armMarquee(false);
      return startMarquee(event);
    }
    const socket = event.target.closest('.sock'),
      element = event.target.closest('.node,.frame'),
      handle = event.target.closest('[data-frame-handle]'),
      edge = event.target.closest('[data-edge]');
    if (event.button === 1 || (event.button === 0 && spaceHeld)) return startPan(event);
    if (event.button !== 0) return;
    if (W.tool === 'pan') return startPan(event);
    if (W.tool === 'delete') {
      if (edge) disconnectMany([edge.dataset.edge]).catch(fail);
      else if (element) {
        const id = element.classList.contains('frame') ? 'frame:' + element.dataset.frame : element.dataset.id;
        select([id]);
        deleteSelection().catch(fail);
      }
      return;
    }
    const preview = event.target.closest('.node .preview-text');
    if (preview && W.tool === 'select') {
      select([preview.closest('.node').dataset.id]);
      return;
    }
    const binding = event.target.closest('[data-binding-group]');
    if (binding) {
      // A binding wire starts at the dot of its slot: pressing on the dot itself drags a new wire from it (an input may be bound to more ports).
      const dot = document
          .elementsFromPoint(event.clientX, event.clientY)
          .find(el => el.matches?.('.frame-ports .port')),
        frame = dot?.closest('.frame');
      if (frame) return startWire(event, frame.dataset.id, dot.querySelector('.sock.external'));
      select(['frame:' + binding.dataset.bindingGroup]);
      return;
    }
    const resize = event.target.closest('[data-resize]');
    if (resize && element) return startResize(event, element, resize.dataset.resize);
    const framePort = element?.classList.contains('frame') ? event.target.closest('.frame-ports .port') : null;
    if (framePort && element) return startWire(event, element.dataset.id, framePort.querySelector('.sock.external'));
    if (socket && element) return startWire(event, element.dataset.id, socket);
    if (W.tool === 'move' && (handle || element?.classList.contains('node'))) {
      const id = handle ? 'frame:' + handle.dataset.frameHandle : element.dataset.id;
      if (!W.selected.has(id)) select([id], event.shiftKey || event.ctrlKey || event.metaKey);
      return startSelectionMove(event);
    }
    if (handle) return startFrameDrag(event, handle.dataset.frameHandle);
    if (element?.classList.contains('node')) return startNodeDrag(event, element.dataset.id);
    if (edge) {
      selectEdges([edge.dataset.edge], event.shiftKey || event.ctrlKey || event.metaKey);
      return;
    }
    if (W.tool === 'move' && W.selected.size && !event.shiftKey && !event.ctrlKey) {
      return startSelectionMove(event);
    }
    if (event.shiftKey || event.ctrlKey) return startMarquee(event);
    if (W.selected.size || W.edges.size) {
      W.edges.clear();
      select([]);
    }
    startMarquee(event);
  });
  const inlineEdits = new Map();
  const queueInline = event => {
    const input = event.target,
      element = input.closest('.node');
    if (!element || !input.matches('[data-literal]')) return;
    const key = element.dataset.id + '|' + input.dataset.literal;
    let entry = inlineEdits.get(key);
    if (!entry) {
      entry = {chain: Promise.resolve()};
      inlineEdits.set(key, entry);
    }
    clearTimeout(entry.timer);
    entry.dirty = true;
    entry.flush = () => {
      clearTimeout(entry.timer);
      if (!entry.dirty) return entry.chain;
      entry.dirty = false;
      const value = input.type === 'checkbox' ? input.checked : input.value;
      entry.chain = entry.chain.then(() => inlineChange(input, value)).catch(fail);
      return entry.chain;
    };
    entry.timer = setTimeout(entry.flush, event.type === 'change' ? 0 : 350);
  };
  canvas.addEventListener('input', queueInline);
  canvas.addEventListener('change', queueInline);
  canvas.addEventListener('change', event => {
    const select = event.target.closest('select[data-event]');
    if (!select) return;
    api(`projects/${W.project}/primitives/${encodeURIComponent(select.dataset.event)}/event`, {
      method: 'PUT',
      body: wf({event: select.value}),
      edit: editToken(),
    })
      .then(reload)
      .catch(fail);
  });
  // The script of an html widget (in its sandboxed frame) sets the widget's value with parent.postMessage({value}, '*').
  if (!W.messageListener) {
    W.messageListener = true;
    window.addEventListener('message', event => {
      const frame = $$('iframe[data-widget-frame]').find(f => f.contentWindow === event.source);
      if (!frame || !event.data || typeof event.data !== 'object' || !('value' in event.data)) return;
      changeWidget(
        frame.closest('[data-widget-node]').dataset.widgetNode,
        frame.dataset.widgetFrame,
        event.data.value
      ).catch(fail);
    });
  }
  W.flushInline = () => Promise.all([...inlineEdits.values()].map(entry => entry.flush()));
  W.inlineDirty = () => [...inlineEdits.values()].some(entry => entry.dirty);
  leaveGuards.push(() => W.flushInline());
  canvas.addEventListener('click', event => {
    const expand = event.target.closest('[data-expand]'),
      collapse = event.target.closest('[data-collapse]');
    if (expand) setCollapsed(expand.dataset.expand, false).catch(fail);
    if (collapse) setCollapsed(collapse.dataset.collapse, true).catch(fail);
    const foldGroup = event.target.closest('[data-fold-group]');
    if (foldGroup) {
      const group = W.groups.get(foldGroup.dataset.foldGroup);
      if (group) setFolded([{kind: 'group', group_id: group.id}], !group.folded).catch(fail);
    }
    const fold = event.target.closest('[data-fold]');
    if (fold) {
      const node = W.nodes.get(fold.dataset.fold);
      if (node) setFolded([node], !node.folded).catch(fail);
    }
    // A button widget counts its clicks.
    const button = event.target.closest('[data-widget-button]');
    if (button) {
      const holder = button.closest('[data-widget-node]'),
        widget = widgetsOf(holder.dataset.widgetNode).find(w => w.id === button.dataset.widgetButton);
      if (widget) changeWidget(holder.dataset.widgetNode, widget.id, (Number(widget.value) || 0) + 1).catch(fail);
    }
  });
  canvas.addEventListener('keydown', event => {
    if (event.target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])')) return;
    if (
      event.target.closest('.preview-text') &&
      (event.ctrlKey || event.metaKey) &&
      keyCode(event) === 'KeyC' &&
      getSelection()?.toString()
    )
      return;
    if (matches('pan', event) || event.code === 'Space') {
      spaceHeld = true;
      canvas.classList.add('panning');
    }
    const step = 80 / W.camera.zoom,
      nudges = {left: [-step, 0], right: [step, 0], up: [0, -step], down: [0, step]};
    for (const [action, [dx, dy]] of Object.entries(nudges))
      if (matches(action, event)) {
        event.preventDefault();
        setCamera(W.camera.x + dx, W.camera.y + dy, W.camera.zoom);
        return;
      }
    const actions = {
      copy: () => copySelection(),
      cut: () => copySelection(true),
      paste: () => paste(),
      delete: async () => {
        // Selected wires are disconnected; selected nodes and groups are deleted.
        if (W.edges.size) await disconnectMany([...W.edges]);
        await deleteSelection();
      },
      dissolve: () => deleteSelection(true),
      group: () => groupSelection(),
      ungroup: () => ungroupSelection(),
      renameGroup: () => renameSelection(),
      selectAll: () => select(visibleNodes().map(n => n.id)),
      marquee: () => armMarquee(!W.marqueeArmed),
      invertSelection: () => invertSelection(),
      fit: () => fit(W.selected.size ? W.selected : undefined),
      zoomIn: () => $('#zoom-in').click(),
      zoomOut: () => $('#zoom-out').click(),
      run: () => (W.library ? undefined : toggleRun()),
      undo: () => undo(false),
      redo: () => undo(true),
      togglePanel: () => Inspector.toggle(),
      disable: () => toggleDisabled(),
      fold: () => toggleFolded(),
      snap: () => setSnap(!W.snap),
      hints: () => setHintsShown(!W.hintsShown),
      toolSelect: () => setTool('select'),
      toolMove: () => setTool('move'),
      toolPan: () => setTool('pan'),
      toolDelete: () => setTool('delete'),
      toolAdd: () => $('.canvas-tools [data-empty-add]', canvas).click(),
      cancel: () => {
        armMarquee(false);
        select([]);
      },
    };
    for (const [action, handler] of Object.entries(actions)) {
      if (matches(action, event)) {
        event.preventDefault();
        Promise.resolve(handler()).catch(fail);
        return;
      }
    }
  });
  canvas.addEventListener('keyup', () => {
    spaceHeld = false;
    canvas.classList.remove('panning');
  });
  document.addEventListener('keydown', globalKeys);
  leaveGuards.push(() => {
    document.removeEventListener('keydown', globalKeys);
  });
  const observer = new ResizeObserver(() => {
    if (canvas !== W.canvas || !canvas.isConnected) return;
    W.viewportSize = {width: canvas.clientWidth, height: canvas.clientHeight};
    if (!W.snapshot) return;
    measure();
    measureFrames();
    drawWires();
    drawMinimap();
  });
  observer.observe(canvas);
  W.nodeObserver = new ResizeObserver(entries => {
    if (canvas !== W.canvas || !canvas.isConnected) return;
    for (const {target} of entries) if (target.isConnected) W.dirtyGeometry.add(target.dataset.id);
    if (W.drag || !W.snapshot) return;
    cancelAnimationFrame(W.measureFrame);
    W.measureFrame = requestAnimationFrame(() => {
      measure(false);
      drawFrames();
      drawWires();
      drawMinimap();
    });
  });
  leaveGuards.push(() => {
    observer.disconnect();
    W.nodeObserver.disconnect();
    cancelAnimationFrame(W.measureFrame);
    cancelAnimationFrame(W.frameHandle);
    W.frameHandle = 0;
    W.frameWork.clear();
  });
}

function globalKeys(event) {
  if (event.target.closest('input,textarea,select,dialog') || $('#modal').open) return;
  if (matches('togglePanel', event) && !event.target.closest('#canvas')) {
    event.preventDefault();
    Inspector.toggle();
  }
}

function startPan(event) {
  const start = {x: event.clientX, y: event.clientY, cx: W.camera.x, cy: W.camera.y};
  W.canvas.classList.add('panning');
  drag(
    event,
    e =>
      setCamera(
        start.cx - (e.clientX - start.x) / W.camera.zoom,
        start.cy - (e.clientY - start.y) / W.camera.zoom,
        W.camera.zoom
      ),
    () => W.canvas.classList.remove('panning')
  );
}

/** The Move tool translates all selected nodes and groups, including a drag from empty space. */
function startSelectionMove(event) {
  const ids = new Set(selectedNodes().filter(node => !isPinned(node.id)).map(node => node.id)),
    groups = new Map();
  for (const gid of selectedGroupIds()) {
    const group = W.groups.get(gid);
    if (group.pinned || groupChainOf(gid).some(g => g.pinned)) continue;
    const content = frameContent(gid);
    for (const id of content.ids) if (!isPinned(id)) ids.add(id);
    for (const g of content.groups)
      if (!g.pinned && !groupChainOf(g.id).some(parent => parent.pinned)) groups.set(g.id, g);
  }
  const origins = new Map([...ids].filter(id => W.pos.has(id)).map(id => [id, {...W.pos.get(id)}]));
  for (const group of groups.values())
    if (group.position?.width || (!group.members.length && !group.children.length)) {
      const pos = group.position || W.pos.get('frame:' + group.id);
      if (pos) origins.set('group:' + group.id, {...pos});
    }
  if (!origins.size) return;
  const start = toWorld(event.clientX, event.clientY), anchor = origins.values().next().value;
  let moved = false;
  W.drag = {ids};
  setHintMode('move');
  drag(event, e => {
    const point = toWorld(e.clientX, e.clientY);
    if (!moved && Math.hypot(point.x - start.x, point.y - start.y) * W.camera.zoom < 3) return;
    moved = true;
    const {dx, dy} = snapMove(anchor, point.x - start.x, point.y - start.y);
    for (const [id, origin] of origins) {
      const x = Math.round(origin.x + dx), y = Math.round(origin.y + dy);
      if (id.startsWith('group:')) {
        const group = W.groups.get(id.slice(6));
        group.position = {...group.position, x, y};
      } else {
        Object.assign(W.pos.get(id), {x, y});
        W.elements.get(id)?.style.setProperty('transform', `translate(${x}px,${y}px)`);
      }
    }
    W.sceneRevision++;
    onNextFrame('drag', () => { drawFrames(); drawWires(); });
  }, async () => {
    W.drag = null;
    setHintMode(null);
    if (moved) await savePositions([...origins.keys()]);
  });
}

function startNodeDrag(event, id) {
  const wasSelected = W.selected.has(id);
  if (!wasSelected || event.shiftKey) select([id], event.shiftKey || event.ctrlKey);
  const movable = [...W.selected].filter(n => W.nodes.has(n) && !isPinned(n));
  // With Ctrl held the nodes the selection feeds (and the ones those feed, and so on) move along.
  const carried = event.ctrlKey ? downstreamOf(movable) : [],
    moving = [...movable, ...carried];
  const start = toWorld(event.clientX, event.clientY),
    origins = new Map(moving.map(n => [n, {...W.pos.get(n)}]));
  const anchor = origins.get(id) ?? [...origins.values()][0];
  let moved = false,
    target = null,
    removing = false,
    wire = null;
  // Frames keep their size while nodes are dragged (they adjust on drop), so drops are judged against them as they were.
  const frames = dropFrames(),
    plain = movable.filter(n => W.nodes.get(n)?.kind !== 'complex'),
    leavable = movable.filter(n => canLeaveGroup(n)),
    zone = $('#unparent-zone');
  W.drag = {ids: new Set(moving)};
  setHintMode('node', {carried: carried.length});
  drag(
    event,
    e => {
      const p = toWorld(e.clientX, e.clientY);
      if (!moved && Math.hypot(p.x - start.x, p.y - start.y) * W.camera.zoom < 3) return;
      const {dx, dy} = snapMove(anchor, p.x - start.x, p.y - start.y);
      moved = true;
      for (const [n, o] of origins) {
        positionNode(n, o.x + dx, o.y + dy);
      }
      W.sceneRevision++;
      // Dropping on the zone at the top takes the nodes out of their group; dropping on a frame puts them in.
      zone.classList.toggle('show', leavable.length > 0);
      if (leavable.length) placeZone(zone, leavable[0]);
      removing = leavable.length > 0 && overZone(zone, e);
      zone.classList.toggle('active', removing);
      const next = removing ? null : (frames.find(f => inRect(p, f.rect))?.id ?? null);
      const differs = next && movable.some(n => parentOf(n) !== next);
      target = differs ? next : null;
      onNextFrame('drag', () => {
        $$('.frame.drop-target').forEach(el => el.classList.remove('drop-target'));
        if (target) $(`.frame[data-frame="${CSS.escape(target)}"]`)?.classList.add('drop-target');
        drawWires();
        drawSelectionTools();
        // A single node released over a wire is inserted into it.
        wire = origins.size === 1 && plain.length === 1 && !target && !removing ? wireUnder(plain[0]) : null;
        if (wire) $(`[data-edge="${CSS.escape(wire.id)}"]`)?.nextElementSibling?.classList.add('insert');
      });
    },
    async () => {
      W.drag = null;
      setHintMode(null);
      zone.classList.remove('show', 'active');
      $$('.frame.drop-target').forEach(el => el.classList.remove('drop-target'));
      // Ctrl+click on a selected node takes it out of the selection (a drag with Ctrl moves it with what it feeds instead).
      if (!moved && event.ctrlKey && wasSelected && !event.shiftKey) select([id], true);
      if (!moved || !origins.size) return;
      await savePositions([...origins.keys()]);
      if (target || removing) await regroup(movable, removing ? null : target);
      else if (wire) await insertIntoWire(plain[0], wire);
    }
  );
}

/** Everything the wires lead to from `ids`: the nodes they feed, the ones those feed, and so on. Only what has a place on the canvas and is not pinned. */
function downstreamOf(ids) {
  const next = new Map();
  for (const edge of visibleEdges()) {
    if (!next.has(edge.source)) next.set(edge.source, []);
    next.get(edge.source).push(edge.target);
  }
  const seen = new Set(ids),
    queue = [...ids],
    found = [];
  while (queue.length)
    for (const target of next.get(queue.pop()) ?? []) {
      if (seen.has(target)) continue;
      seen.add(target);
      queue.push(target);
      if (W.nodes.has(target) && W.pos.has(target) && !W.hidden.nodes.has(target) && !isPinned(target))
        found.push(target);
    }
  return found;
}

const inRect = (p, r) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
/** Puts the "take out of the group" zone just above the top edge of the group `id` is in (kept inside the canvas). */
function placeZone(zone, id) {
  const frame = W.pos.get('frame:' + parentOf(id));
  if (!frame) return;
  const {x, y, zoom} = W.camera,
    width = W.canvas.clientWidth,
    half = zone.offsetWidth / 2 + 8;
  zone.style.left = Math.max(half, Math.min(width - half, (frame.x + frame.w / 2 - x) * zoom)) + 'px';
  zone.style.top = Math.max(zone.offsetHeight + 12, (frame.y - y) * zoom) + 'px';
}
const overZone = (zone, e) => {
  const r = zone.getBoundingClientRect();
  return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
};
/** Rectangles of the frames that nodes can be dropped into, innermost first. */
function dropFrames() {
  return W.snapshot.groups
    .filter(g => W.pos.has('frame:' + g.id) && !W.complex.get(g.id)?.collapsed && !W.complex.get(g.id)?.locked)
    .map(g => ({id: g.id, depth: g.depth, rect: {...W.pos.get('frame:' + g.id)}}))
    .sort((a, b) => b.depth - a.depth);
}
/** What can be put into a group: a node, a collapsed Complex Node ('complex:ID') or a whole frame ('frame:ID'). */
const nestedGroupId = id => (id.startsWith('complex:') ? id.slice(8) : id.startsWith('frame:') ? id.slice(6) : null);
/** The group an item sits in now (null at the top level). */
const parentOf = id => {
  const gid = nestedGroupId(id);
  return gid ? (W.groups.get(gid)?.parent ?? null) : parentGroupOf(W.nodes.get(id));
};
/** In a Custom Node editor everything stays inside the main group; elsewhere an item can leave any group. */
function canLeaveGroup(id) {
  const group = parentOf(id);
  return !!group && !(W.library && isRoot(group)) && !isRoot(nestedGroupId(id));
}
/** Puts the dragged items into a group (or, with no target, one level out of the group they are in). */
async function regroup(ids, target) {
  const to = new Map();
  for (const id of ids) {
    const from = parentOf(id),
      gid = nestedGroupId(id);
    if (isPinned(gid ? 'group:' + gid : id)) continue;
    const dest = target ?? (canLeaveGroup(id) ? (W.groups.get(from)?.parent ?? null) : from);
    if (dest !== from) to.set(id, dest);
  }
  if (!to.size) return;
  const groups = W.snapshot.groups.map(g => {
    const members = g.members.filter(m => !to.has(m) || to.get(m) === g.id);
    for (const [id, dest] of to) if (dest === g.id && !nestedGroupId(id) && !members.includes(id)) members.push(id);
    const moved = [...to].find(([id]) => nestedGroupId(id) === g.id);
    let position = g.position;
    if (g.members.length && !members.length && !position) {
      const r = W.pos.get('frame:' + g.id);
      if (r) position = {x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.w), height: Math.round(r.h)};
    }
    return {id: g.id, name: g.name, position, members, parent: moved ? moved[1] : g.parent};
  });
  await saveGroups(groups);
  await reload();
}
/** The wire (not touching the node) closest to a dragged node's body, if the node could be put in it. The area is generous. */
function wireUnder(id) {
  const p = W.pos.get(id),
    node = W.nodes.get(id);
  if (!p || !node) return null;
  const pad = 28 / W.camera.zoom,
    box = {x0: p.x - pad, x1: p.x + p.w + pad, y0: p.y - pad, y1: p.y + Math.min(p.h, 90) + pad},
    cx = p.x + p.w / 2,
    cy = p.y + Math.min(p.h, 90) / 2;
  let best = null;
  for (const edge of visibleEdges()) {
    if (edge.source === id || edge.target === id) continue;
    // The wire's own points (as drawn), measured in plain arithmetic: no layout query per wire and sample.
    const a = socketPoint(edge.source, 'out', edge.source_port),
      b = socketPoint(edge.target, 'in', edge.target_port);
    if (!a || !b || !insertPorts(node, edge)) continue;
    const points = edgePoints(a, b, graphStyle);
    for (let i = 1; i < points.length; i++) {
      const [u, v] = [points[i - 1], points[i]],
        steps = Math.max(1, Math.ceil(Math.hypot(v.x - u.x, v.y - u.y) / 12));
      for (let k = 0; k <= steps; k++) {
        const x = u.x + ((v.x - u.x) * k) / steps,
          y = u.y + ((v.y - u.y) * k) / steps;
        if (x < box.x0 || x > box.x1 || y < box.y0 || y > box.y1) continue;
        const d = Math.hypot(x - cx, y - cy);
        if (!best || d < best.d) best = {d, edge};
      }
    }
  }
  return best?.edge ?? null;
}
/** The ports of a node that an inserted wire would use: one it can take the wire's data into, one that can feed its target. */
function insertPorts(node, edge) {
  const out = W.nodes.get(edge.source)?.outputs?.find(q => q.id === edge.source_port),
    inn = W.nodes.get(edge.target)?.inputs?.find(q => q.id === edge.target_port);
  if (!out || !inn) return null;
  const types = W.types ?? NO_TYPES,
    input = (node.inputs || []).find(q => (!q.connected || isSignal(q.type)) && compatible(out.type, q.type, types)),
    output = (node.outputs || []).find(q => compatible(q.type, inn.type, types));
  return input || output ? {input, output} : null;
}
async function insertIntoWire(id, edge) {
  const node = W.nodes.get(id),
    ports = insertPorts(node, edge);
  if (!ports) return;
  const add = [];
  if (ports.input)
    add.push({source: edge.source, source_port: edge.source_port, target: id, target_port: ports.input.id});
  if (ports.output)
    add.push({source: id, source_port: ports.output.id, target: edge.target, target_port: edge.target_port});
  await api(`projects/${W.project}/port-connections`, {
    method: 'POST',
    body: wf({remove: [edgeChange(edge)], add}),
    edit: editToken(),
  });
  await reload();
}

function startResize(event, element, direction) {
  const frame = element.classList.contains('frame'),
    id = element.dataset.id;
  const gid = frame ? element.dataset.frame : W.nodes.get(id)?.group_id;
  const cx = gid ? W.complex.get(gid) : null;
  const posKey = frame ? 'frame:' + gid : id;
  if (isPinned(frame ? 'group:' + gid : id)) return;
  const origin = {...W.pos.get(posKey)},
    start = toWorld(event.clientX, event.clientY);
  const members = frame
    ? frameContent(gid)
        .ids.map(n => W.pos.get(n))
        .filter(Boolean)
    : [];
  const oldMin = element.style.minHeight;
  if (!frame) element.style.minHeight = '0';
  const minH = frame
    ? Math.max(100, 64 + Math.max(cx?.inputs?.length || 0, cx?.outputs?.length || 0) * 28)
    : Math.max(cx ? 78 : 64, element.offsetHeight);
  element.style.minHeight = oldMin;
  const minW = frame ? 260 : 160;
  let bounds = {...origin},
    moved = false;
  W.drag = {ids: new Set([posKey])};
  setHintMode('resize');
  drag(
    event,
    e => {
      const p = toWorld(e.clientX, e.clientY),
        dx = p.x - start.x,
        dy = p.y - start.y;
      let left = origin.x,
        top = origin.y,
        right = origin.x + origin.w,
        bottom = origin.y + origin.h;
      if (direction.includes('e')) right = snapValue(right + dx);
      if (direction.includes('s')) bottom = snapValue(bottom + dy);
      if (direction.includes('w')) left = snapValue(left + dx);
      if (direction.includes('n')) top = snapValue(top + dy);
      if (direction.includes('w')) left = Math.max(right - 4000, Math.min(left, right - minW));
      else right = Math.min(left + 4000, Math.max(right, left + minW));
      if (direction.includes('n')) top = Math.max(bottom - 4000, Math.min(top, bottom - minH));
      else bottom = Math.min(top + 4000, Math.max(bottom, top + minH));
      if (members.length) {
        left = Math.min(left, ...members.map(p => p.x - 20));
        top = Math.min(top, ...members.map(p => p.y - 44));
        right = Math.max(right, ...members.map(p => p.x + p.w + 20));
        bottom = Math.max(bottom, ...members.map(p => p.y + p.h + 20));
      }
      bounds = {x: Math.round(left), y: Math.round(top), w: Math.round(right - left), h: Math.round(bottom - top)};
      moved = true;
      Object.assign(W.pos.get(posKey), bounds);
      if (frame && cx) W.pos.set('complex:' + gid, W.pos.get(posKey));
      element.style.transform = `translate(${bounds.x}px,${bounds.y}px)`;
      element.style.width = bounds.w + 'px';
      element.style[frame ? 'height' : 'minHeight'] = bounds.h + 'px';
      onNextFrame('drag', () => {
        if (frame) measureFrames();
        else {
          measure();
          drawFrames();
        }
        drawWires();
        drawMinimap();
      });
    },
    async e => {
      try {
        if (!moved || e.type === 'pointercancel') return;
        const edit = editToken(),
          position = {x: bounds.x, y: bounds.y};
        if (frame) {
          Object.assign(position, {width: bounds.w, height: bounds.h});
          await api(`projects/${W.project}/layout`, {
            method: 'PUT',
            body: wf({positions: {['group:' + gid]: position}}),
            edit,
          });
        } else if (cx) {
          await api(`projects/${W.project}/layout`, {method: 'PUT', body: wf({positions: {[id]: position}}), edit});
          await api(`projects/${W.project}/complex/${encodeURIComponent(gid)}`, {
            method: 'PUT',
            body: wf({compact_size: {width: bounds.w, height: bounds.h}}),
            edit,
          });
        } else {
          Object.assign(position, {width: bounds.w, height: bounds.h});
          await api(`projects/${W.project}/layout`, {method: 'PUT', body: wf({positions: {[id]: position}}), edit});
        }
      } finally {
        W.drag = null;
        setHintMode(null);
        await reload();
      }
    }
  );
}

function isPinned(id) {
  if (id.startsWith('group:'))
    return W.groups.get(id.slice(6))?.pinned || groupChainOf(id.slice(6)).some(g => g.pinned);
  return (
    W.nodes.get(id)?.pinned ||
    groupChain(id).some(g => g.pinned) ||
    (id.startsWith('complex:') && groupChainOf(id.slice(8)).some(g => g.pinned))
  );
}
/** The enclosing groups of a group, innermost first. */
function groupChainOf(gid) {
  const chain = [];
  for (let g = W.groups.get(W.groups.get(gid)?.parent), n = 0; g && n < 64; g = W.groups.get(g.parent), n++)
    chain.push(g);
  return chain;
}

function startFrameDrag(event, groupId) {
  const group = W.groups.get(groupId);
  select(['frame:' + groupId], event.shiftKey);
  if (group.pinned || groupChainOf(groupId).some(g => g.pinned)) return;
  const {ids, groups} = frameContent(groupId);
  const members = ids.filter(id => W.pos.has(id));
  const start = toWorld(event.clientX, event.clientY),
    origins = new Map(members.map(n => [n, {...W.pos.get(n)}]));
  // Frames that only exist as saved positions (empty groups, or a minimum size) move along too.
  for (const g of groups)
    if (g.position?.width || (!g.members.length && !g.children.length))
      origins.set('group:' + g.id, {
        x: g.position?.x ?? W.pos.get('frame:' + g.id).x,
        y: g.position?.y ?? W.pos.get('frame:' + g.id).y,
      });
  W.drag = {ids: new Set(members)};
  setHintMode('frame');
  // The corner of what the group holds is what snaps to the grid.
  const anchor = origins.size
    ? {x: Math.min(...[...origins.values()].map(o => o.x)), y: Math.min(...[...origins.values()].map(o => o.y))}
    : null;
  // Like a node, a frame can be dropped into another group, or out of its own through the zone at the top.
  const item = 'frame:' + groupId,
    zone = $('#unparent-zone'),
    leavable = canLeaveGroup(item),
    frames = isRoot(groupId) ? [] : dropFrames().filter(f => f.id !== groupId && !isUnder(W.groups.get(f.id), groupId));
  let moved = false,
    target = null,
    removing = false;
  drag(
    event,
    e => {
      const p = toWorld(e.clientX, e.clientY);
      if (!moved && Math.hypot(p.x - start.x, p.y - start.y) * W.camera.zoom < 3) return;
      moved = true;
      const {dx, dy} = snapMove(anchor, p.x - start.x, p.y - start.y);
      for (const [n, o] of origins) {
        if (n.startsWith('group:')) {
          const g = W.groups.get(n.slice(6));
          g.position = {...g.position, x: o.x + dx, y: o.y + dy};
          continue;
        }
        positionNode(n, o.x + dx, o.y + dy);
      }
      W.sceneRevision++;
      zone.classList.toggle('show', leavable);
      if (leavable) placeZone(zone, item);
      removing = leavable && overZone(zone, e);
      zone.classList.toggle('active', removing);
      const next = removing ? null : (frames.find(f => inRect(p, f.rect))?.id ?? null);
      target = next && next !== parentOf(item) ? next : null;
      onNextFrame('drag', () => {
        drawFrames();
        drawWires();
        if (target) $(`.frame[data-frame="${CSS.escape(target)}"]`)?.classList.add('drop-target');
      });
    },
    async () => {
      W.drag = null;
      setHintMode(null);
      zone.classList.remove('show', 'active');
      if (!moved) return;
      await savePositions([...origins.keys()]);
      if (target || removing) await regroup([item], removing ? null : target);
    }
  );
}

async function savePositions(ids) {
  const positions = Object.fromEntries(
    ids.map(id => {
      const p = id.startsWith('group:') && !W.pos.has(id) ? W.groups.get(id.slice(6)).position : W.pos.get(id);
      return [
        id,
        {
          x: Math.round(p.x),
          y: Math.round(p.y),
          ...(id.startsWith('group:') && p.width ? {width: p.width, height: p.height} : {}),
        },
      ];
    })
  );
  try {
    await api(`projects/${W.project}/layout`, {method: 'PUT', body: wf({positions}), edit: editToken()});
  } catch (error) {
    fail(error);
  }
  scheduleReload(50);
}

/** True when the segment pвЂ“q touches the rectangle (its sides included). */
function segmentHitsRect(p, q, rect) {
  let near = 0,
    far = 1;
  for (const [delta, low, high] of [
    [q.x - p.x, rect.x - p.x, rect.r - p.x],
    [q.y - p.y, rect.y - p.y, rect.b - p.y],
  ]) {
    if (delta === 0) {
      if (low > 0 || high < 0) return false;
      continue;
    }
    const [from, to] = low / delta <= high / delta ? [low / delta, high / delta] : [high / delta, low / delta];
    near = Math.max(near, from);
    far = Math.min(far, to);
    if (near > far) return false;
  }
  return true;
}

/** Wires whose line passes through a rectangle given in canvas coordinates. */
function crossedEdges(a, b) {
  const hits = [],
    rect = {x: a.x, y: a.y, r: b.x, b: b.y};
  for (const edge of visibleEdges()) {
    const p = socketPoint(edge.source, 'out', edge.source_port),
      q = socketPoint(edge.target, 'in', edge.target_port);
    if (!p || !q) continue;
    const points = edgePoints(p, q, graphStyle);
    for (let i = 1; i < points.length; i++)
      if (segmentHitsRect(points[i - 1], points[i], rect)) {
        hits.push(edge.id);
        break;
      }
  }
  return hits;
}

function startMarquee(event) {
  const box = $('#marquee'),
    rect = W.canvas.getBoundingClientRect(),
    start = {x: event.clientX, y: event.clientY};
  const base = new Set(W.selected);
  let crossed = [];
  drag(
    event,
    e => {
      const x0 = Math.min(start.x, e.clientX),
        y0 = Math.min(start.y, e.clientY),
        x1 = Math.max(start.x, e.clientX),
        y1 = Math.max(start.y, e.clientY);
      Object.assign(box.style, {
        left: x0 - rect.left + 'px',
        top: y0 - rect.top + 'px',
        width: x1 - x0 + 'px',
        height: y1 - y0 + 'px',
      });
      box.hidden = false;
      const a = toWorld(x0, y0),
        b = toWorld(x1, y1);
      W.selected = new Set(base);
      for (const [id, p] of W.pos)
        if (W.elements.has(id) && p.x < b.x && p.x + p.w > a.x && p.y < b.y && p.y + p.h > a.y) W.selected.add(id);
      // A group is taken when its whole frame is inside the rectangle.
      for (const g of W.snapshot.groups) {
        const p = W.pos.get('frame:' + g.id);
        if (
          p &&
          !W.complex.get(g.id)?.collapsed &&
          !isRoot(g.id) &&
          p.x >= a.x &&
          p.y >= a.y &&
          p.x + p.w <= b.x &&
          p.y + p.h <= b.y
        )
          W.selected.add('frame:' + g.id);
      }
      paintSelection();
      // A rectangle that catches no node or group takes the wires it crosses.
      crossed = W.selected.size === base.size ? crossedEdges(a, b) : [];
    },
    () => {
      box.hidden = true;
      if (crossed.length) selectEdges(crossed, false);
      else select([...W.selected]);
    }
  );
}

/** The B key: the next drag on the canvas draws a selection rectangle instead of panning. */
function armMarquee(on) {
  W.marqueeArmed = on;
  W.canvas?.classList.toggle('marquee-armed', on);
  if (on) toast('Drag on the canvas to select a rectangle. Esc cancels.');
}

/** Read the theme-derived fill too: an uncoloured node has no explicit `color`. */
function selectionColor() {
  const item = selectionItems()[0];
  if (item?.color) return item.color;
  const element =
    item?.kind === 'group'
      ? $(`.frame[data-frame="${CSS.escape(item.group_id)}"]`, W.canvas)
      : W.elements.get(item?.id);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = getComputedStyle(element || W.canvas).backgroundColor;
  ctx.fillRect(0, 0, 1, 1);
  const rgba = [...ctx.getImageData(0, 0, 1, 1).data];
  return (
    '#' +
    rgba
      .slice(0, rgba[3] === 255 ? 3 : 4)
      .map(c => c.toString(16).padStart(2, '0'))
      .join('')
  );
}
function openColorPicker(anchor) {
  colorPicker(anchor, {color: selectionColor(), none: true, onPick: color => setSelectionStyle({color}).catch(fail)});
}

// ---- hints ----
// Snapping to the canvas grid, and the strip of key hints along the bottom of the canvas (like the status bar of Blender).

/** The grid the nodes and groups snap to: the spacing of the dots the canvas draws at 100% zoom. */
const SNAP_SIZE = 24;

const snapped = value => Math.round(value / SNAP_SIZE) * SNAP_SIZE;
/** `value` moved to the grid when snapping is on. */
const snapValue = value => (W.snap ? snapped(value) : value);
/** The move (dx, dy) that puts `origin` plus the move on the grid when snapping is on: everything that moves with it keeps its place. */
function snapMove(origin, dx, dy) {
  return W.snap && origin ? {dx: snapped(origin.x + dx) - origin.x, dy: snapped(origin.y + dy) - origin.y} : {dx, dy};
}

function setSnap(on, save = true) {
  W.snap = !!on;
  if (save) store.set('agentsys.client.v1.snap', W.snap);
  const button = $('#snap-toggle');
  if (button) {
    button.setAttribute('aria-pressed', String(W.snap));
    button.title = `Snap to the grid (${shortcutText('snap')}): ${W.snap ? 'on' : 'off'}`;
  }
  updateHints();
}

function setHintsShown(on, save = true) {
  W.hintsShown = !!on;
  if (save) store.set('agentsys.client.v1.hints', W.hintsShown);
  const button = $('#hints-toggle');
  if (button) {
    button.setAttribute('aria-pressed', String(W.hintsShown));
    button.title = `Key hints (${shortcutText('hints')}): ${W.hintsShown ? 'shown' : 'hidden'}`;
  }
  updateHints();
}

/** What the person is doing right now, for the hints: null (nothing special), 'node', 'frame', 'resize', 'wire' or 'marquee'. */
function setHintMode(mode, detail = {}) {
  W.hintMode = mode;
  W.hintDetail = detail;
  updateHints();
}

/** The hints for the current mode and selection: [[keys, label, highlighted?], ...]. */
function hintList() {
  const key = shortcutText,
    snap = [key('snap'), `Snap ${W.snap ? 'off' : 'on'}`],
    detail = W.hintDetail || {};
  switch (W.hintMode) {
    case 'move':
      return [['Drag', 'Move selection'], snap, ['Middle drag / Space+drag', 'Pan']];
    case 'node':
      return [
        ['Drag', 'Move'],
        [
          'Ctrl',
          detail.carried
            ? `Moving ${plural(detail.carried, 'node')} downstream too`
            : 'Hold at the start to move the nodes it feeds too',
          !!detail.carried,
        ],
        snap,
        ['Drop on a group', 'Put in it'],
        ['Drop on a wire', 'Insert'],
      ];
    case 'frame':
      return [['Drag', 'Move the group'], snap, ['Drop on a group', 'Put in it']];
    case 'resize':
      return [['Drag', 'Resize'], snap];
  }
  if (W.tool === 'delete') return [['Click', 'Delete node, group or wire'], [key('undo'), 'Undo'], ['Middle drag / Space+drag', 'Pan']];
  if (W.tool === 'pan') return [['Drag', 'Pan'], ['Wheel', 'Zoom'], [key('fit'), 'Fit']];
  const items = [];
  if (W.edges.size)
    return [
      [key('delete'), 'Disconnect'],
      ['Click', 'Select another'],
      [key('cancel'), 'Deselect'],
    ];
  if (W.selected.size) {
    items.push(
      ['Drag', W.tool === 'move' ? 'Move selection (also from empty space)' : 'Move'],
      ['Ctrl+Drag', 'Move with the nodes it feeds'],
      [key('multiSelect') + '+Click', 'Add to selection']
    );
    items.push(
      [key('copy'), 'Copy'],
      [key('delete'), 'Delete'],
      [key('group'), 'Group'],
      [key('dissolve'), 'Dissolve'],
      [key('disable'), 'Disable'],
      [key('fold'), 'Collapse']
    );
    if (selectedFrames().length) items.push([key('renameGroup'), 'Rename']);
    items.push(snap, [key('fit'), 'Fit selection']);
    return items;
  }
  items.push(
    ['Drag', W.tool === 'pan' ? 'Pan' : 'Box select'],
    ['Middle drag / Space+drag', 'Pan'],
    ['Wheel', 'Zoom'],
    [key('marquee'), 'Box select'],
    [key('selectAll'), 'Select all'],
    ['Right click', 'Add / menu']
  );
  if (!W.library) items.push([key('run'), 'Run']);
  items.push([key('undo'), 'Undo'], snap, [key('fit'), 'Fit'], [key('togglePanel'), 'Panel']);
  return items;
}

function updateHints() {
  const button = $('#hints-toggle');
  if (!button) return;
  const strip = $('#canvas-hints');
  if (strip) {
    strip.hidden = !W.hintsShown;
    strip.innerHTML = hintList().map(([keys, label]) => `<span><kbd>${esc([].concat(keys).join(' + '))}</kbd> ${esc(label)}</span>`).join('');
  }
  button.title =
    'Keyboard shortcuts' +
    (W.hintsShown
      ? '\n' +
        hintList()
          .map(([keys, label]) => [].concat(keys).join(' + ') + ' - ' + label)
          .join('\n')
      : ` (${shortcutText('hints')})`);
}

function wireHints() {
  setSnap(store.get('agentsys.client.v1.snap', false), false);
  setHintsShown(store.get('agentsys.client.v1.hints', true), false);
  $('#snap-toggle').onclick = () => setSnap(!W.snap);
  $('#hints-toggle').onclick = () => setHintsShown(!W.hintsShown);
}

// ---- wires ----
// Creating, moving and removing wires, and binding Complex Node ports.

// ----- wires -----
function startWire(event, nodeId, socket) {
  const endpoint = (id, sock) => ({
    id,
    port: sock.dataset.port,
    dir: sock.dataset.dir,
    face: sock.dataset.face || '',
    interface: sock.dataset.interface,
  });
  let from = endpoint(nodeId, socket),
    previous = null,
    sides = null,
    origin = null,
    moved = false;
  // A Complex Node's interface slot is one dot with two faces. Dragging it toward something inside the group
  // uses the internal face (acts as the opposite kind of socket); anywhere else uses the external one.
  const frameComplex = nodeId.startsWith('complex:') ? W.complex.get(nodeId.slice(8)) : null;
  if (frameComplex && socket.closest('.frame-ports')) {
    sides = {
      complex: frameComplex,
      external: from,
      internal: endpoint(nodeId, socket.closest('.port').querySelector('.sock.internal')),
    };
  }
  if (from.dir === 'in' && !from.face) {
    previous = visibleEdges().find(e => e.target === nodeId && e.target_port === from.port);
    if (previous) {
      origin = {id: nodeId, port: from.port};
      from = {id: previous.source, port: previous.source_port, dir: 'out', face: ''};
      if (sides) sides.external = from;
    }
  }
  const pointOf = f => socketPoint(f.id, f.dir, f.port, f.face);
  const press = {x: event.clientX, y: event.clientY};
  W.canvas.classList.add('wiring');
  drag(
    event,
    e => {
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > 4) moved = true;
      const cursor = toWorld(e.clientX, e.clientY);
      $$('.drop-target').forEach(el => el.classList.remove('drop-target'));
      const over = target(e)?.element;
      over?.classList.add('drop-target');
      over?.closest('.node.reroute')?.classList.add('drop-target');
      const a = pointOf(from);
      drawWires(from.dir === 'out' ? {a, b: cursor} : {a: cursor, b: a});
    },
    async e => {
      W.canvas.classList.remove('wiring');
      $$('.drop-target').forEach(el => el.classList.remove('drop-target'));
      const drop = target(e);
      drawWires();
      if (e.type === 'pointercancel') return;
      // Dragging a wire off the input it was attached to, and letting go in empty space, unplugs it.
      if (previous && moved && !drop) return disconnect(previous.id);
      if (!drop || drop.id === from.id) return;
      if (previous && origin && drop.id === origin.id && drop.port === origin.port) return;
      const out = from.dir === 'out' ? from : drop,
        input = from.dir === 'in' ? from : drop;
      if (out.face === 'internal') return bindComplexPort(out.id.slice(8), 'inputs', out.port, input);
      if (input.face === 'internal') return bindComplexPort(input.id.slice(8), 'outputs', input.port, out);
      await connect(out, input, previous);
    }
  );
  function target(e) {
    const hit = document.elementFromPoint(e.clientX, e.clientY),
      element = hit?.closest('.node,.frame');
    if (sides) from = sides.complex.members.includes(element?.dataset.id) ? sides.internal : sides.external;
    if (!element) return null;
    const id = element.dataset.id,
      node = W.nodes.get(id),
      desired = from.dir === 'out' ? 'in' : 'out';
    if (element.classList.contains('frame')) {
      const framePort = hit.closest('.frame-ports .port');
      if (!framePort) return null;
      // A node inside the group binds to the port's internal face (toward the group's own members);
      // anything else wires to its external face (toward the outside world).
      const complex = W.complex.get(element.dataset.frame);
      const internal = complex?.members.includes(from.id);
      const sock = framePort.querySelector(internal ? '.sock.internal' : '.sock.external');
      const hitFrame = sock && sock.dataset.dir === desired ? {...endpoint(id, sock), element: sock} : null;
      return hitFrame && endpointsFit(from, hitFrame) ? hitFrame : null;
    }
    const sock = hit.closest('.sock') || hit.closest('.port')?.querySelector(`.sock[data-dir=${desired}]`);
    if (sock) {
      const hitSocket = sock.dataset.dir === desired ? {...endpoint(id, sock), element: sock} : null;
      return hitSocket && endpointsFit(from, hitSocket) ? hitSocket : null;
    }
    // Dropped on the node itself: the first free port that the wire fits.
    const free = (node?.[desired === 'in' ? 'inputs' : 'outputs'] || []).find(
      p =>
        (desired === 'out' || !p.connected || isSignal(p.type)) &&
        endpointsFit(from, {id, port: p.id, dir: desired, face: ''})
    );
    return free ? {id, port: free.id, dir: desired, face: '', element} : null;
  }
}

/**
 * Binds the slot `portId` of a Complex Node to the port `endpoint` inside it, or (`unbind`: {node_id, port_id}) takes one binding away.
 * An input may be bound to several ports inside, so a new binding is added; an output has one, so the new binding replaces it.
 */
async function bindComplexPort(groupId, direction, portId, endpoint, unbind = null) {
  await Inspector.pending?.();
  const cx = W.complex.get(groupId);
  if (endpoint && !cx.members.includes(endpoint.id))
    throw new Error('Connect this port to something inside the Complex Node.');
  const memberPort = endpoint && W.nodes.get(endpoint.id)?.[direction].find(p => p.id === endpoint.port);
  if (endpoint && !memberPort) throw new Error('Connect this port to a port inside the Complex Node.');
  const next = {
    ...cx.interface,
    [direction]: cx.interface[direction].map(p => {
      if (p.id !== portId) return p;
      const {bound = [], ...rest} = p,
        other = b =>
          !(endpoint && b.node_id === endpoint.id && b.port_id === endpoint.port) &&
          !(unbind && b.node_id === unbind.node_id && b.port_id === unbind.port_id),
        added = endpoint ? [{node_id: endpoint.id, port_id: endpoint.port}] : [],
        next = direction === 'inputs' ? [...bound.filter(other), ...added] : endpoint ? added : bound.filter(other);
      return next.length ? {...rest, bound: next} : rest;
    }),
  };
  await api(`projects/${W.project}/complex/${encodeURIComponent(groupId)}`, {
    method: 'PUT',
    body: wf({interface: next}),
    edit: editToken(),
  });
  Inspector.editing = null;
  Inspector.pending = null;
  await reload();
}
const edgeChange = edge => ({
  source: edge.source,
  target: edge.target,
  source_port: edge.source_port,
  target_port: edge.target_port,
});
async function connect(from, to, previous = null) {
  const change = {source: from.id, source_port: from.port, target: to.id, ...(to.port ? {target_port: to.port} : {})};
  await api(`projects/${W.project}/port-connections`, {
    method: 'POST',
    body: wf({add: [change], ...(previous ? {remove: [edgeChange(previous)]} : {})}),
    edit: editToken(),
  });
  await reload();
}

const disconnect = edgeId => disconnectMany([edgeId]);

async function disconnectMany(ids) {
  const edges = W.snapshot.edges.filter(e => ids.includes(e.id));
  if (!edges.length) return;
  await api(`projects/${W.project}/port-connections`, {
    method: 'POST',
    body: wf({remove: edges.map(edgeChange)}),
    edit: editToken(),
  });
  W.edges.clear();
  await reload();
}

/** Inserts reroute points at the current canvas cursor. */
async function splitEdges(ids) {
  const splits = W.snapshot.edges
    .filter(e => ids.includes(e.id))
    .map(e => ({edge_id: e.id, position: spawnPoint()}))
    .map(s => ({edge_id: s.edge_id, position: {x: Math.round(s.position.x - 11), y: Math.round(s.position.y - 11)}}));
  if (!splits.length) return;
  const result = await api(`projects/${W.project}/split-connections`, {
    method: 'POST',
    body: wf({splits}),
    edit: editToken(),
  });
  W.edges.clear();
  await reload();
  select(result.ids);
}

// ---- menus ----
// The Add node menu and the selection (context) menu.

function spawnPoint() {
  const rect = W.canvas.getBoundingClientRect();
  const pointer = W.pointer || {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
  return toWorld(pointer.x, pointer.y);
}

/** Everything that can be added to the canvas, as popup items. */
function addItems({all = false} = {}) {
  const at = spawnPoint();
  const available = new Set(W.snapshot?.library_nodes ?? []);
  const customNodes = (app.resources || []).filter(r => r.id !== W.library && (all || available.has(r.id)));
  const place = item => async () => {
    const result = await api(`projects/${W.project}/custom-nodes/${item.id}`, {
      method: 'POST',
      body: wf({point: at}),
      edit: editToken(),
    });
    await reload();
    select(pastedSelection(result));
  };
  // Library groups ("Logic/Sub") become nested submenus; nodes without a group sit directly in the menu.
  const tree = {nodes: [], groups: new Map()};
  for (const item of customNodes) {
    let level = tree,
      path = '';
    for (const part of String(item.payload.folder || '')
      .split('/')
      .filter(Boolean)) {
      path = path ? path + '/' + part : part;
      if (!level.groups.has(part)) level.groups.set(part, {nodes: [], groups: new Map(), path});
      level = level.groups.get(part);
    }
    level.nodes.push(item);
  }
  // The nodes of a level first, then its groups.
  const menuOf = level => [
    ...level.nodes.map(item => [item.name, place(item), {icon: item.payload.icon || 'complex', hint: ''}]),
    ...[...level.groups].map(([name, sub]) => [
      name,
      null,
      {icon: (app.nodeFolderIcons || {})[sub.path] || 'package', children: menuOf(sub)},
    ]),
  ];
  // The two nodes the engine is made of come first; everything else is built from them (and comes from the Library).
  const primitive = (name, kind, glyph) => [
    name,
    async () => {
      const result = await api(`projects/${W.project}/primitives`, {
        method: 'POST',
        body: wf({primitive: kind, point: at}),
        edit: editToken(),
      });
      await reload();
      select([result.id]);
    },
    {icon: glyph, hint: ''},
  ];
  const library = menuOf(tree);
  const pluginItems =
    typeof Extensions === 'undefined'
      ? []
      : Extensions.menuItems('canvas:add', [{project: W.project, workflow: W.workflow, point: at}]);
  return [
    primitive('Script', 'script', 'code'),
    primitive('Event', 'event', 'bolt'),
    ...(library.length ? [null, ...library] : []),
    ...(pluginItems.length ? [null, ...pluginItems] : []),
  ];
}
function addMenu(x, y) {
  popup(x, y, addItems(), {search: true, searchItems: addItems({all: true})});
}

/** What to select after pasting: the new top-level groups, plus any pasted nodes that are not inside one. */
function pastedSelection(result) {
  const ids = new Set(result.ids || []),
    roots = result.roots || [];
  const inside = new Set(roots.flatMap(gid => W.groups.get(gid)?.all_members || []));
  return [...roots.map(selectionIdOf), ...[...ids].filter(id => !inside.has(id) && W.nodes.has(id))];
}

function selectionMenu() {
  const plain = plainNodes(),
    groupIds = selectedGroupIds(),
    any = plain.length + groupIds.length > 0,
    shortcut = shortcutText;
  const single = groupIds.length === 1 && W.selected.size === 1 ? W.groups.get(groupIds[0]) : null,
    cx = single ? W.complex.get(single.id) : null;
  const rootOnly = W.selected.size === 1 && isRoot(selectedFrames()[0]?.id);
  const pinned = selectionItems().some(n => n.pinned),
    switchable = switchableItems(),
    off = switchable.length > 0 && switchable.every(n => n.disabled),
    foldable = foldableItems(),
    folded = foldable.length > 0 && foldable.every(n => n.folded);
  const pluginItems =
    typeof Extensions === 'undefined'
      ? []
      : Extensions.menuItems('canvas:selection', [
          {
            project: W.project,
            workflow: W.workflow,
            selected: [
              ...plainNodes().map(n => n.id),
              ...groupIds.map(id => 'complex:' + id),
            ],
          },
        ]);
  return [
    ['Copy', () => copySelection(), {icon: 'copy', hint: shortcut('copy'), disabled: !any}],
    ['Cut', () => copySelection(true), {icon: 'cut', hint: shortcut('cut'), disabled: !any}],
    ['Paste', () => paste(), {icon: 'paste', hint: shortcut('paste'), disabled: !hasClipboard()}],
    null,
    ['Group', () => groupSelection(), {icon: 'group', hint: shortcut('group'), disabled: !any}],
    [
      'Ungroup',
      () => ungroupSelection(),
      {
        icon: 'ungroup',
        hint: shortcut('ungroup'),
        disabled: !groupIds.length || groupIds.some(id => W.complex.get(id)?.locked),
      },
    ],
    ...(W.selected.size === 1 && (single || selectedNodes()[0]?.kind === 'function')
      ? [['Rename', () => renameSelection(), {icon: 'pencil', hint: shortcut('renameGroup')}]]
      : []),
    ...(single && cx?.locked && cx.source && developerMode()
      ? [['Edit graph', () => editInLibrary(cx.source.resource_id), {icon: 'pencil'}]]
      : []),
    ...(rootOnly
      ? [['Rename', () => renameGroup(selectedFrames()[0].id), {icon: 'pencil', hint: shortcut('renameGroup')}]]
      : []),
    [pinned ? 'Unpin' : 'Pin', () => setPinned(!pinned), {icon: pinned ? 'unpin' : 'pin', disabled: !any}],
    [
      off ? 'Enable' : 'Disable',
      () => toggleDisabled()?.catch(fail),
      {icon: 'power', hint: shortcut('disable'), disabled: !switchable.length},
    ],
    [
      folded ? 'Expand' : 'Collapse',
      () => setFolded(foldable, !folded).catch(fail),
      {icon: folded ? 'expand' : 'collapse', hint: shortcut('fold'), disabled: !foldable.length},
    ],
    null,
    ['Dissolve', () => deleteSelection(true), {icon: 'merge', hint: shortcut('dissolve'), disabled: !plain.length}],
    ['Delete', () => deleteSelection(), {icon: 'trash', danger: true, hint: shortcut('delete'), disabled: !any}],
    ...(pluginItems.length ? [null, ...pluginItems] : []),
  ];
}

// ---- commands ----
// Commands that change the graph: inline edits, delete, copy/paste, group/ungroup, Library save, undo.

// ----- editing -----
/** The widgets of a Custom node (by node ID). */
const widgetsOf = id => W.snapshot.widgets?.[id] ?? [];

/** A multi-selection is one edit and one commit, rather than a round trip per selected item. */
async function applyCanvasEdits(operations, edit = editToken()) {
  for (let i = 0; i < operations.length; i += 200)
    await api(`projects/${W.project}/batch`, {
      method: 'POST',
      body: wf({operations: operations.slice(i, i + 200)}),
      edit,
    });
}

/** One value edit lifecycle for widgets and free input/output controls. The endpoint owns the event semantics. */
async function changeNodeValue(endpoint, nodeId, fieldId, value) {
  await api(`projects/${W.project}/${endpoint}`, {
    method: 'PUT',
    body: wf({node_id: nodeId, values: {[fieldId]: value}}),
    edit: editToken(),
  });
  W.results.delete(nodeId);
  await reload();
}
const changeWidget = (...args) => changeNodeValue('widget-values', ...args);
const changeInput = (...args) => changeNodeValue('input-values', ...args);
const changeOutput = (...args) => changeNodeValue('output-values', ...args);

/** A field of a widget changed (data-literal is the widget's ID), or of the control of a free input or output (its ID is in:<port> or out:<port>). */
async function inlineChange(input, captured = input.type === 'checkbox' ? input.checked : input.value) {
  const slot = input.closest('.port'),
    holder = slot ? input.closest('.node') : input.closest('[data-widget-node]');
  if (!holder) return;
  const nodeId = slot ? holder.dataset.id : holder.dataset.widgetNode,
    widget = (slot ? slotWidgets(W.nodes.get(nodeId)) : widgetsOf(nodeId)).find(w => w.id === input.dataset.literal);
  if (!widget) return;
  let value = captured;
  if (widget.kind === 'number' || widget.kind === 'range') {
    // A number field reports "-" or "1e" as empty: that is a number being typed, so it waits for the rest.
    if (input.validity?.badInput) return;
    value = captured === '' ? null : Number(captured);
    if (value !== null && !Number.isFinite(value)) return;
  } else if (widget.kind === 'select') {
    const option = widget.options?.[Number(captured)];
    value = option !== null && typeof option === 'object' ? option.value : option;
  }
  if (widget.id.startsWith('out:')) await changeOutput(nodeId, widget.id.slice(4), value);
  else if (slot) await changeInput(nodeId, widget.id.slice(3), value);
  else await changeWidget(nodeId, widget.id, value);
}

async function setSelectionStyle(style) {
  const edit = editToken(),
    operations = [];
  for (const node of selectionItems()) {
    const grouped = node.kind === 'group' || node.kind === 'complex';
    if (style.pinned && grouped) {
      const ids = (W.groups.get(node.group_id)?.all_members || []).filter(id => !W.nodes.get(id)?.position);
      if (ids.length) await savePositions(ids);
    }
    const p = W.pos.get(node.id);
    const target = grouped ? {group_id: node.group_id} : {node_id: node.id, ...(p ? {position: {x: p.x, y: p.y}} : {})};
    operations.push({path: 'node-style', body: {...target, ...style}});
  }
  await applyCanvasEdits(operations, edit);
  await reload();
}
const setPinned = pinned => setSelectionStyle({pinned});

/** The style target of a node, a Complex Node or a group frame. */
const styleTarget = node =>
  node.kind === 'complex' || node.kind === 'group' ? {group_id: node.group_id} : {node_id: node.id};
/** What can be disabled: every selected node, Complex Node and group. */
const switchableItems = () => selectionItems();
/** Disables nodes and groups (a run skips them and everything inside, and what they feed gets nothing from them) or enables them again. */
async function setDisabled(items, disabled) {
  await applyCanvasEdits(items.map(node => ({path: 'node-style', body: {...styleTarget(node), disabled}})));
  await reload();
}
const toggleDisabled = () => {
  const items = switchableItems();
  return items.length ? setDisabled(items, !items.every(n => n.disabled)) : undefined;
};

/** What can be collapsed: nodes, Complex Nodes and groups (a Complex Node that is open as a frame in the Library editor is not). */
const foldableItems = () => selectionItems().filter(n => n.kind !== 'group' || !W.complex.has(n.group_id));
/** Collapses nodes (only the header and the slots stay) and groups (only the header stays, the members are hidden), or opens them again. */
async function setFolded(items, folded) {
  await applyCanvasEdits(items.map(node => ({path: 'node-style', body: {...styleTarget(node), folded}})));
  for (const node of items) {
    // What a collapsed group hides cannot stay selected.
    if (node.kind === 'group' && folded) {
      const gone = new Set([...(W.groups.get(node.group_id)?.all_members || [])]);
      select([...W.selected].filter(id => !gone.has(id)));
    }
  }
  await reload();
}
const toggleFolded = () => {
  const items = foldableItems();
  return items.length ? setFolded(items, !items.every(n => n.folded)) : undefined;
};

/** Results belong to nodes, and survive edits. Only removed nodes lose their previews. */
function discardStaleRun() {
  const alive = new Set([...W.snapshot.nodes.map(n => n.id), ...W.snapshot.complex.map(c => 'complex:' + c.id)]);
  for (const map of [W.runStatus, W.results]) for (const id of map.keys()) if (!alive.has(id)) map.delete(id);
}

async function deleteSelection(dissolve = false) {
  await flushNodeEdits();
  const nodes = plainNodes(),
    groupIds = selectedGroupIds();
  if (!nodes.length && !groupIds.length) return;
  const edit = editToken(),
    gone = [],
    operations = [];
  // Outer groups first: deleting one takes the groups inside it with it, so those need no call of their own.
  for (const gid of [...groupIds].sort((a, b) => W.groups.get(a).depth - W.groups.get(b).depth)) {
    if (gone.some(outer => isUnder(W.groups.get(gid), outer))) continue;
    operations.push({path: 'groups/' + gid, method: 'DELETE'});
    gone.push(gid);
  }
  const grouped = new Set(gone.flatMap(id => W.groups.get(id).all_members));
  const live = nodes.map(n => n.id).filter(id => !grouped.has(id));
  if (live.length) operations.push({path: 'delete-nodes', method: 'POST', body: {node_ids: live, dissolve}});
  await applyCanvasEdits(operations, edit);
  W.selected.clear();
  await reload();
  Inspector.show();
}

async function copySelection(cut = false) {
  await flushNodeEdits();
  const nodes = plainNodes(),
    groupIds = selectedGroupIds();
  if (!nodes.length && !groupIds.length) return;
  const bundle = await api(`projects/${W.project}/copy`, {
    method: 'POST',
    body: wf({node_ids: nodes.map(n => n.id), group_ids: groupIds}),
  });
  await store.set('agentsys.client.v1.clipboard', bundle);
  const count = bundle.records.length;
  toast(cut ? 'Cut.' : `Copied ${plural(count || bundle.groups.length, count ? 'node' : 'group')}.`);
  if (cut) await deleteSelection();
}

async function paste() {
  const bundle = store.get('agentsys.client.v1.clipboard');
  if (!bundle) return toast('The clipboard is empty. Copy nodes first.');
  const result = await api(`projects/${W.project}/paste`, {
    method: 'POST',
    body: wf({clipboard: bundle, point: spawnPoint()}),
    edit: editToken(),
  });
  await reload();
  select(pastedSelection(result));
}

/** Saves the whole group list. A group with nothing inside keeps a position; one that lost everything is dropped. */
async function saveGroups(groups, edit = editToken()) {
  const alive = new Set(groups.map(g => g.id));
  const parentOf = g => (g.parent && alive.has(g.parent) ? g.parent : null);
  const keep = groups.filter(g => g.members.length || groups.some(o => parentOf(o) === g.id) || g.position);
  const kept = new Set(keep.map(g => g.id));
  await api(`projects/${W.project}/groups`, {
    method: 'PUT',
    body: wf({
      groups: keep.map(g => ({
        id: g.id,
        name: g.name,
        members: g.members,
        parent: g.parent && kept.has(g.parent) ? g.parent : null,
        ...(g.members.length || keep.some(o => o.parent === g.id) ? {} : {position: g.position}),
      })),
    }),
    edit,
  });
}

/** Groups the selected nodes and groups into a new group; the new group sits where the selection sat. */
async function groupSelection() {
  const ids = plainNodes().map(n => n.id),
    childIds = selectedGroupIds();
  if (!ids.length && !childIds.length) return toast('Select nodes to group.');
  const parents = new Set([
    ...ids.map(id => groupChain(id)[0]?.id ?? null),
    ...childIds.map(id => W.groups.get(id).parent ?? null),
  ]);
  const parent = parents.size === 1 ? [...parents][0] : null;
  const id = uuid();
  const groups = W.snapshot.groups.map(g => ({
    id: g.id,
    name: g.name,
    position: g.position,
    members: g.members.filter(m => !ids.includes(m)),
    parent: childIds.includes(g.id) ? id : g.parent,
  }));
  await saveGroups([...groups, {id, name: 'Group', members: ids, parent}]);
  await reload();
  select(['frame:' + id]);
  renameGroup();
}

/** Removes the selected groups but keeps what was inside them (a Complex Node's wires move to the ports it was bound to). */
async function ungroupSelection() {
  const gone = new Set(selectedGroupIds());
  if (!gone.size) return;
  if ([...gone].some(id => W.complex.get(id)?.locked))
    return toast('A Complex Node is an ordinary node here. Edit it in the [Library](/library).', true);
  const parentOf = g => {
    let p = g.parent;
    while (p && gone.has(p)) p = W.groups.get(p)?.parent ?? null;
    return p;
  };
  await saveGroups(
    W.snapshot.groups
      .filter(g => !gone.has(g.id))
      .map(g => ({id: g.id, name: g.name, position: g.position, members: g.members, parent: parentOf(g)}))
  );
  await reload();
  select([]);
}

/** Renames the selected node or group on the canvas (a Custom node, a Complex Node placed from the Library, a group). */
function renameSelection() {
  const item = primarySelection();
  if (item?.kind === 'group') return renameGroup(item.group.id);
  const node = item?.node;
  if (node?.kind !== 'function') return;
  inlineRename($(`.node[data-id="${CSS.escape(node.id)}"] .title`), nodeLabel(node), async title => {
    await api(`projects/${W.project}/node-title`, {
      method: 'PUT',
      body: wf({node_id: node.id, title}),
      edit: editToken(),
    });
    await reload();
  });
}

function renameGroup(id = primarySelection()?.group?.id) {
  const group = W.groups.get(id);
  if (!group) return;
  const title =
    $(`.frame[data-frame="${CSS.escape(id)}"] .title`) || $(`.node[data-id="complex:${CSS.escape(id)}"] .title`);
  inlineRename(title, group.name, name => saveGroupName(group.id, name));
}
/** Gives a group a new name (a group is kept as a list with the others, so the whole list is saved). */
async function saveGroupName(id, name) {
  await saveGroups(
    W.snapshot.groups.map(g => ({
      id: g.id,
      name: g.id === id ? name : g.name,
      members: g.members,
      parent: g.parent,
      position: g.position,
    }))
  );
  await reload();
}

/** Opens a Library node in its graph editor (the only place where a Complex Node can be changed). */
async function editInLibrary(resourceId) {
  await flushNodeEdits();
  await openNodeEditor(resourceId);
}

async function setCollapsed(groupId, collapsed) {
  if (W.complex.get(groupId)?.locked)
    return toast('A Complex Node is an ordinary node here. Edit it in the [Library](/library).', true);
  const edit = editToken();
  if (collapsed) {
    const frame = W.pos.get('frame:' + groupId);
    if (frame)
      await api(`projects/${W.project}/layout`, {
        method: 'PUT',
        body: wf({positions: {['complex:' + groupId]: {x: frame.x, y: frame.y}}}),
        edit,
      });
  }
  await api(`projects/${W.project}/complex/${encodeURIComponent(groupId)}`, {
    method: 'PUT',
    body: wf({collapsed}),
    edit,
  });
  await reload();
  select([collapsed ? 'complex:' + groupId : 'frame:' + groupId]);
}

async function undo(redo) {
  await flushNodeEdits();
  const status = await api(`projects/${W.project}/${redo ? 'redo' : 'undo'}`, {method: 'POST', body: wf()});
  if (!status[redo ? 'redo' : 'undo'] && !W.history[redo ? 'redo' : 'undo'])
    toast(redo ? 'Nothing to redo.' : 'Nothing to undo.');
  await reload();
}
