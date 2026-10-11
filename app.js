(function () {
  const CONFIG = window.KANBAN_CONFIG || {};
  const STATUSES = [
    { key: "todo", label: "To Do" },
    { key: "in_progress", label: "In Progress" },
    { key: "done", label: "Done" },
  ];
  const STATUS_LABELS = { todo: "To Do", in_progress: "In Progress", done: "Done" };
  const PALETTE = ["#5b5ff0", "#e0524c", "#2fa66a", "#d99a2b", "#0891b2", "#c026d3", "#4f46e5", "#b45309"];

  document.getElementById("board-title").textContent = CONFIG.boardName || "Team Board";

  if (!CONFIG.supabaseUrl || CONFIG.supabaseUrl.includes("YOUR-PROJECT-REF")) {
    document.getElementById("app").innerHTML =
      '<div style="max-width:520px;margin:80px auto;text-align:center;font-family:sans-serif;color:#444;">' +
      "<h2>Setup needed</h2><p>Open <code>config.js</code> and fill in your Supabase project URL and anon key, " +
      "then reload this page. See README.md for step-by-step instructions.</p></div>";
    return;
  }

  const sb = window.supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey);

  let members = [];
  let stories = [];
  let tasks = []; // only tasks that belong to a story (story_id set)
  // false until supabase-migration-task-assignees.sql has been run; tasks then
  // fall back to the single tasks.assignee_id column.
  let multiAssigneeReady = true;
  // Set when task_assignees failed to load for any other reason; assignee writes
  // are blocked until a load succeeds.
  let assigneeLoadError = null;
  let whoamiId = localStorage.getItem("kanban_whoami_id") || null;
  let filterMine = false;
  let editingStoryId = null;
  let editingStatus = "todo";
  let dragItem = null; // { kind: "story", id }

  // Tasks added while creating a brand-new story are staged here and
  // saved together with the story (a new story has no id yet).
  let draftTasks = [];
  let draftSeq = 0;

  let editingTaskId = null;
  let editingTaskStatus = "in_progress";
  let taskStoryId = null; // story the task popup is working on
  let taskIsDraft = false; // true = task of a not-yet-saved story (staged in memory)

  const $ = (sel) => document.querySelector(sel);
  const boardEl = $("#board");

  function colorFor(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return PALETTE[h % PALETTE.length];
  }

  // members.color is written by clients, so only #rgb / #rgba / #rrggbb /
  // #rrggbbaa is ever put into a style attribute; anything else gets the
  // name-derived palette color.
  function safeColor(m) {
    const c = m && m.color;
    if (typeof c === "string" && /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(c)) return c;
    return colorFor((m && m.name) || "");
  }

  function initials(name) {
    return name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((p) => p[0].toUpperCase())
      .join("");
  }

  function toast(msg) {
    const holder = document.getElementById("toast-holder");
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = msg;
    holder.appendChild(el);
    setTimeout(() => el.remove(), 2600);
  }

  function memberById(id) {
    return members.find((m) => m.id === id);
  }

  function storyById(id) {
    return stories.find((s) => s.id === id);
  }

  function tasksForStory(storyId) {
    return tasks
      .filter((t) => t.story_id === storyId)
      .sort((a, b) => a.position - b.position);
  }

  // Assigned member ids of a task (empty = unassigned): its task_assignees rows,
  // with the legacy single assignee_id always included and listed first (it is
  // what older clients show and edit, so it must stay the "first" assignee).
  function taskAssigneeIds(t) {
    const ids = (t.assignee_ids || []).filter((id) => id !== t.assignee_id);
    return t.assignee_id ? [t.assignee_id].concat(ids) : ids;
  }

  // Only these mean "task_assignees doesn't exist yet" (migration not run);
  // anything else (network, permissions, ...) is a real error.
  function isMissingTableError(error) {
    return !!error && (error.code === "PGRST205" || error.code === "42P01");
  }

  // Loads ALL rows of a table. PostgREST caps each response (1000 rows by
  // default), so page with a keyset on the primary key (`keys`, uuid columns)
  // until an empty page; unlike offsets this can't skip rows when others change
  // between pages. Any failed page fails the whole load: a partial list is never
  // returned.
  const PAGE_SIZE = 1000;
  async function loadAllRows(table, columns, keys) {
    const rows = [];
    const seen = new Set();
    let last = null;

    for (;;) {
      let query = sb.from(table).select(columns);
      keys.forEach((k) => (query = query.order(k)));
      query = query.limit(PAGE_SIZE);

      if (last) {
        // (k1 > v1) or (k1 = v1 and k2 > v2)
        const [k1, k2] = keys;
        query = query.or(
          k2
            ? k1 + ".gt." + last[k1] + ",and(" + k1 + ".eq." + last[k1] + "," + k2 + ".gt." + last[k2] + ")"
            : k1 + ".gt." + last[k1]
        );
      }

      const { data, error } = await query;

      if (error) return { data: null, error };
      if (!data || data.length === 0) return { data: rows, error: null };

      for (const r of data) {
        const key = keys.map((k) => r[k]).join("|");
        if (seen.has(key)) return { data: null, error: { message: table + " paging did not advance" } };
        seen.add(key);
      }

      rows.push(...data);
      last = data[data.length - 1];
    }
  }

  // Sorts rows by `col` (then id) in place: the order the server used to apply.
  function sortRows(rows, col) {
    return rows.sort((a, b) =>
      a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0
    );
  }

  function currentUserName() {
    return whoamiId && memberById(whoamiId) ? memberById(whoamiId).name : "someone";
  }

  function isStoryModalOpen() {
    return $("#story-overlay").style.display === "flex";
  }

  // ---------- data loading ----------
  async function loadAll() {
    const [mRes, sRes, tRes, aRes] = await Promise.all([
      loadAllRows("members", "*", ["id"]),
      loadAllRows("stories", "*", ["id"]),
      loadAllRows("tasks", "*", ["id"]),
      loadAllRows("task_assignees", "task_id, member_id, created_at", ["task_id", "member_id"]),
    ]);

    if (mRes.error) return toast("Couldn't load members: " + mRes.error.message);
    if (sRes.error)
      return toast("Couldn't load stories: " + sRes.error.message + " (has the stories SQL migration been applied?)");
    if (tRes.error) return toast("Couldn't load tasks: " + tRes.error.message);
    if (aRes.error && !isMissingTableError(aRes.error)) {
      // Keep the last complete data on screen rather than showing partial assignees.
      assigneeLoadError = aRes.error;
      return toast("Couldn't load task assignees: " + aRes.error.message + ". Assignee changes are paused until it loads.");
    }

    members = sortRows(mRes.data || [], "created_at");
    stories = sortRows(sRes.data || [], "position");
    tasks = sortRows((tRes.data || []).filter((t) => t.story_id), "position");

    // A missing task_assignees table just means the migration hasn't run yet.
    assigneeLoadError = null;
    multiAssigneeReady = !aRes.error;
    const assigned = {};
    (aRes.data || [])
      .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.member_id < b.member_id ? -1 : 1))
      .forEach((r) => (assigned[r.task_id] = assigned[r.task_id] || []).push(r.member_id));
    tasks.forEach((t) => (t.assignee_ids = assigned[t.id] || []));

    render();

    // keep an open story modal's task list in sync with real-time changes
    if (isStoryModalOpen() && editingStoryId) renderStoryTaskList();
    // same for the team modal's task progress
    if ($("#members-overlay").style.display === "flex") renderMemberManageList();
  }

  sb
    .channel("kanban-sync")
    .on("postgres_changes", { event: "*", schema: "public", table: "stories" }, loadAll)
    .on("postgres_changes", { event: "*", schema: "public", table: "tasks" }, loadAll)
    .on("postgres_changes", { event: "*", schema: "public", table: "members" }, loadAll)
    .subscribe();

  // Separate channel so a not-yet-created task_assignees table can't break the main sync.
  sb
    .channel("kanban-sync-assignees")
    .on("postgres_changes", { event: "*", schema: "public", table: "task_assignees" }, loadAll)
    .subscribe();

  // ---------- who-am-i ----------
  function renderWhoamiOptions(selectEl) {
    selectEl.innerHTML = "";

    if (members.length === 0) {
      const opt = document.createElement("option");
      opt.textContent = "No members yet — add yourself below";
      opt.disabled = true;
      selectEl.appendChild(opt);
      return;
    }

    members.forEach((m) => {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.name;
      selectEl.appendChild(opt);
    });
  }

  function showWhoamiModal() {
    renderWhoamiOptions($("#whoami-select"));

    if (whoamiId && memberById(whoamiId)) {
      $("#whoami-select").value = whoamiId;
    }

    $("#whoami-overlay").style.display = "flex";
  }

  $("#whoami-add").onclick = async () => {
    const name = $("#whoami-new-name").value.trim();
    if (!name) return;

    const { data, error } = await sb
      .from("members")
      .insert({ name, color: colorFor(name) })
      .select()
      .single();

    if (error) return toast("Couldn't add member: " + error.message);

    members.push(data);
    $("#whoami-new-name").value = "";
    renderWhoamiOptions($("#whoami-select"));
    $("#whoami-select").value = data.id;
  };

  $("#whoami-continue").onclick = () => {
    const sel = $("#whoami-select");

    if (!sel.value) return toast("Pick or add your name first");

    whoamiId = sel.value;
    localStorage.setItem("kanban_whoami_id", whoamiId);
    $("#whoami-overlay").style.display = "none";
    render();
  };

  $("#whoami-chip").onclick = showWhoamiModal;

  // ---------- members management ----------
  $("#manage-members-btn").onclick = () => {
    renderMemberManageList();
    $("#members-overlay").style.display = "flex";
  };

  $("#members-close").onclick = () => ($("#members-overlay").style.display = "none");

  $("#members-add").onclick = async () => {
    const input = $("#new-member-name");
    const name = input.value.trim();

    if (!name) return;

    const { data, error } = await sb
      .from("members")
      .insert({ name, color: colorFor(name) })
      .select()
      .single();

    if (error) return toast("Couldn't add member: " + error.message);

    members.push(data);
    input.value = "";
    renderMemberManageList();
    render();
  };

  function renderMemberManageList() {
    const list = $("#member-manage-list");
    list.innerHTML = "";

    if (members.length === 0) {
      list.innerHTML = '<div class="empty-hint">No team members yet.</div>';
      return;
    }

    // Count every loaded task once under each of its assignees (unassigned tasks are skipped).
    const stats = {};
    tasks.forEach((t) => {
      taskAssigneeIds(t).forEach((id) => {
        const s = stats[id] || (stats[id] = { todo: 0, in_progress: 0, done: 0 });
        if (t.status in s) s[t.status]++;
      });
    });

    members.forEach((m) => {
      const s = stats[m.id] || { todo: 0, in_progress: 0, done: 0 };
      const total = s.todo + s.in_progress + s.done;
      const pct = total ? Math.round((s.done / total) * 100) : 0;

      const row = document.createElement("div");
      row.className = "member-row";

      row.innerHTML =
        '<span class="avatar member-avatar" style="background:' +
        safeColor(m) +
        '">' +
        escapeHtml(initials(m.name)) +
        '</span><div class="member-info"><div class="member-top"><span class="member-name">' +
        escapeHtml(m.name) +
        '</span><span class="member-pct">' +
        pct +
        '%</span></div><div class="member-progress" role="progressbar" aria-label="Tasks done" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' +
        pct +
        '"><div class="member-progress-fill" style="width:' +
        pct +
        '%"></div></div><div class="member-counts">' +
        STATUSES.map(
          (st) =>
            '<span class="member-count"><span class="dot ' + st.key + '"></span>' + s[st.key] + " " + st.label + "</span>"
        ).join("") +
        "</div></div>";

      const del = document.createElement("button");
      del.className = "btn ghost small";
      del.textContent = "Remove";

      del.onclick = async () => {
        if (!confirm('Remove "' + m.name + '"? Their stories and tasks will become unassigned.')) return;

        const { error } = await sb.from("members").delete().eq("id", m.id);

        if (error) return toast("Couldn't remove: " + error.message);

        members = members.filter((x) => x.id !== m.id);
        renderMemberManageList();
        render();
      };

      row.appendChild(del);
      list.appendChild(row);
    });
  }

  // ---------- "my tasks" filter ----------
  $("#my-tasks-toggle").onclick = () => {
    if (!whoamiId) return showWhoamiModal();

    filterMine = !filterMine;
    $("#my-tasks-toggle").classList.toggle("active", filterMine);
    render();
  };

  // ---------- board filters (function / task category / priority / story / status) ----------
  const boardFilters = { function: "", category: "", priority: "", story: "", status: "" };

  function refreshStoryFilterOptions() {
    const sel = $("#filter-story");
    if (!sel) return;

    const list = stories
      .slice()
      .sort((a, b) => (a.title || "").localeCompare(b.title || ""));

    sel.innerHTML = '<option value="">All stories</option>';
    list.forEach((s) => {
      const opt = document.createElement("option");
      opt.value = s.id;
      opt.textContent = (s.title || "").replace(/\s+/g, " ").trim();
      sel.appendChild(opt);
    });

    if (!stories.some((s) => s.id === boardFilters.story)) boardFilters.story = "";
    sel.value = boardFilters.story;
  }

  // Functions were renamed/merged; older stories may still carry an old value.
  const LEGACY_FUNCTIONS = {
    Engineer: "Engineering",
    Product: "Products",
    Marketing: "Marketing & Lead Generation",
    "Lead Generation": "Marketing & Lead Generation",
  };
  function normalizeFunction(f) {
    return LEGACY_FUNCTIONS[f] || f;
  }

  // Story-level filters (function / priority / story).
  function storyMatchesFilters(s) {
    if (boardFilters.function && (normalizeFunction(s.function) || "") !== boardFilters.function) return false;
    if (boardFilters.priority && (s.priority || "medium").toLowerCase() !== boardFilters.priority) return false;
    if (boardFilters.story && s.id !== boardFilters.story) return false;
    return true;
  }

  // Task-level filters (task category / "My tasks only").
  function taskMatchesFilters(t) {
    if (boardFilters.category && (t.category || "").toLowerCase() !== boardFilters.category.toLowerCase()) return false;
    if (filterMine && whoamiId && !taskAssigneeIds(t).includes(whoamiId)) return false;
    return true;
  }

  // The board shows stories only: with a task-level filter on, a story stays when
  // one of its tasks matches (or, for "My tasks only", when the story itself is mine).
  function storyMatchesTaskFilters(st) {
    const mine = filterMine && whoamiId;
    if (!boardFilters.category && !mine) return true;
    if (tasksForStory(st.id).some(taskMatchesFilters)) return true;
    return !boardFilters.category && st.assignee_id === whoamiId;
  }

  [
    ["function", "#filter-function"],
    ["category", "#filter-category"],
    ["priority", "#filter-priority"],
    ["story", "#filter-story"],
    ["status", "#filter-status"],
  ].forEach(([name, sel]) => {
    $(sel).onchange = () => {
      boardFilters[name] = $(sel).value;
      render();
    };
  });

  // ---------- shared helpers for modals ----------
  // escapeHtml leaves quotes alone, so values placed inside attributes use this.
  function escapeAttr(s) {
    return escapeHtml(s).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function avatarHtml(m) {
    return '<span class="avatar" style="background:' + safeColor(m) + '">' + escapeHtml(initials(m.name)) + "</span>";
  }


  // ---------- task cards inside the story popup ----------
  const ICON_CALENDAR =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="2" y="3" width="12" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
  const ICON_EDIT =
    '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M10.5 2.5l3 3L6 13H3v-3z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>';
  const ICON_DELETE =
    '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M2.5 4.5h11M6.5 4.5V3h3v1.5M4 4.5l.7 8.5h6.6l.7-8.5M6.8 7v4M9.2 7v4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  // "2026-12-01" -> "Dec 1, 2026" (in the viewer's locale); other values as-is.
  function formatDay(day) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day || "");
    if (!m) return day;
    return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  function taskDetailHtml(cls, label, bodyHtml) {
    return '<div class="story-task-detail ' + cls + '"><span class="detail-label">' + label + "</span>" + bodyHtml + "</div>";
  }

  // Every assignee (avatar + full name), nobody hidden, with the count in the label.
  function taskAssigneesDetailHtml(ids) {
    const people = ids.map(memberById).filter(Boolean);

    return taskDetailHtml(
      "detail-assignees",
      'Assignees<span class="detail-count" aria-label="' + people.length + (people.length === 1 ? ' assignee">' : ' assignees">') + people.length + "</span>",
      people.length
        ? '<ul class="assignee-list">' +
            people
              .map((m) => '<li class="assignee-person" title="' + escapeAttr(m.name) + '">' + avatarHtml(m) + '<span class="assignee-name">' + escapeHtml(m.name) + "</span></li>")
              .join("") +
            "</ul>"
        : '<span class="detail-empty story-task-unassigned">Unassigned</span>'
    );
  }

  // ---------- task assignee multi-select ----------
  let pickerIds = []; // member ids selected in the task popup, in order
  let pickerFromIds = []; // the task's task_assignees rows when the popup opened

  function renderAssigneePicker() {
    renderAssigneeChips();
    renderAssigneeMenu();
  }

  function renderAssigneeChips() {
    const box = $("#task-assignees-box");
    const chosen = pickerIds.map(memberById).filter(Boolean);

    box.innerHTML = chosen.length
      ? chosen
          .map(
            (m) =>
              '<span class="assignee-chip">' +
              avatarHtml(m) +
              escapeHtml(m.name) +
              '<button type="button" class="assignee-chip-remove" data-id="' +
              escapeAttr(m.id) +
              '" aria-label="Remove ' +
              escapeAttr(m.name) +
              '">&times;</button></span>'
          )
          .join("")
      : '<span class="assignee-placeholder">Unassigned</span>';
  }

  function renderAssigneeMenu() {
    const menu = $("#task-assignees-menu");
    menu.innerHTML = "";

    if (members.length === 0) {
      menu.innerHTML = '<div class="empty-hint">No team members yet.</div>';
      return;
    }

    members.forEach((m) => {
      const opt = document.createElement("label");
      opt.className = "assignee-option";
      opt.innerHTML = '<input type="checkbox" />' + avatarHtml(m) + escapeHtml(m.name);

      const cb = opt.querySelector("input");
      cb.checked = pickerIds.includes(m.id);
      cb.onchange = () => {
        pickerIds = cb.checked ? pickerIds.concat(m.id) : pickerIds.filter((id) => id !== m.id);
        renderAssigneeChips();
      };

      menu.appendChild(opt);
    });
  }

  function setAssigneeMenuOpen(open) {
    $("#task-assignees-menu").hidden = !open;
    $("#task-assignees").classList.toggle("open", open);
    $("#task-assignees-box").setAttribute("aria-expanded", String(open));
  }

  $("#task-assignees-box").onclick = (e) => {
    const remove = e.target.closest(".assignee-chip-remove");

    if (remove) {
      pickerIds = pickerIds.filter((id) => id !== remove.dataset.id);
      renderAssigneePicker();
      return;
    }

    setAssigneeMenuOpen($("#task-assignees-menu").hidden);
  };

  $("#task-assignees-box").onkeydown = (e) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setAssigneeMenuOpen($("#task-assignees-menu").hidden);
    } else if (e.key === "Escape") {
      setAssigneeMenuOpen(false);
    }
  };

  document.addEventListener("click", (e) => {
    // (a removed chip is already detached from the page by the time this runs)
    if (!$("#task-assignees-menu").hidden && e.target.isConnected && !$("#task-assignees").contains(e.target))
      setAssigneeMenuOpen(false);
  });

  // Applies only what this edit changed: `ids` is the wanted list, `fromIds` the
  // task's task_assignees rows when the popup opened. Members nobody touched here
  // (e.g. added meanwhile in another tab) are left alone. Adds go first, so a
  // failure never leaves a task with fewer assignees.
  async function syncTaskAssignees(taskId, ids, fromIds) {
    if (!multiAssigneeReady) return null;

    // only members the user could see and pick are ever added
    const added = ids.filter((id) => !fromIds.includes(id) && memberById(id));
    const removed = fromIds.filter((id) => !ids.includes(id));

    if (added.length) {
      const { error } = await sb
        .from("task_assignees")
        .upsert(
          added.map((id) => ({ task_id: taskId, member_id: id })),
          { onConflict: "task_id,member_id", ignoreDuplicates: true }
        );

      if (error) return error;
    }

    if (removed.length) {
      const { error } = await sb.from("task_assignees").delete().eq("task_id", taskId).in("member_id", removed);
      if (error) return error;
    }

    return null;
  }

  // Assignee writes need a complete, freshly loaded list. Retries the load once.
  async function assigneesLoadedOrWarn() {
    if (assigneeLoadError) await loadAll();
    if (!assigneeLoadError) return true;

    toast("Can't save assignees: they couldn't be loaded (" + assigneeLoadError.message + "). Check your connection and try again.");
    return false;
  }

  function warnIfSingleAssigneeOnly(ids) {
    if (!multiAssigneeReady && ids.length > 1)
      toast("Only the first assignee was saved: run the task_assignees migration to enable multiple assignees");
  }

  // ---------- story modal ----------
  function openStoryModal(status, storyId) {
    editingStoryId = storyId || null;
    editingStatus = status;
    draftTasks = [];

    const story = storyId ? storyById(storyId) : null;
    if (storyId && !story) editingStoryId = null;

    $("#story-modal-title").textContent = story ? "Edit Story" : "New Story";
    $("#story-title").value = story ? story.title : "";
    $("#story-desc").value = story ? story.description || "" : "";
    $("#story-done-when").value = story ? story.done_when || "" : "";
    $("#story-due").value = story && story.due_date ? story.due_date : "";
    $("#story-function").value = story ? normalizeFunction(story.function) || "" : "Engineering";
    $("#story-priority").value = story && story.priority ? story.priority : "medium";
    $("#story-delete").style.display = story ? "inline-block" : "none";

    setStoryStatusTab(status);
    renderStoryTaskList();

    $("#story-overlay").style.display = "flex";
    setTimeout(() => $("#story-title").focus(), 30);
  }

  function closeStoryModal() {
    $("#story-overlay").style.display = "none";
    $("#task-overlay").style.display = "none";
    draftTasks = [];
    editingStoryId = null;
  }

  function setStoryStatusTab(status) {
    editingStatus = status;

    document.querySelectorAll("#story-status-tabs .status-tab").forEach((el) => {
      el.classList.toggle("active", el.dataset.status === status);
    });
  }

  document.querySelectorAll("#story-status-tabs .status-tab").forEach((el) => {
    el.onclick = () => setStoryStatusTab(el.dataset.status);
  });

  $("#story-cancel").onclick = closeStoryModal;
  $("#story-close").onclick = closeStoryModal;

  // ---------- tasks list inside the story modal ----------
  function getModalTasks() {
    return editingStoryId ? tasksForStory(editingStoryId) : draftTasks;
  }

  function renderStoryTaskList() {
    const list = $("#story-task-list");
    list.innerHTML = "";

    const items = getModalTasks();

    if (items.length === 0) {
      list.innerHTML = '<div class="empty-hint">No tasks yet. Use "+ New Task" to add one.</div>';
      return;
    }

    const today = new Date().toISOString().slice(0, 10);

    // Tasks have no Done When and usually no due date of their own, so the card
    // shows the story's (from this form, so unsaved edits show too).
    const storyDue = $("#story-due").value;
    const storyDoneWhen = $("#story-done-when").value.trim();

    items.forEach((t) => {
      const due = t.due_date || storyDue;
      const overdue = due && due < today && t.status !== "done";
      const priority = t.priority ? String(t.priority).toLowerCase() : "";

      const row = document.createElement("div");
      row.className = "story-task-row";
      row.dataset.status = t.status;

      // header: title + icon actions top-right
      const head = document.createElement("div");
      head.className = "story-task-head";

      const name = document.createElement("p");
      name.className = "story-task-name";
      name.textContent = t.title;

      const actions = document.createElement("div");
      actions.className = "story-task-actions";

      const edit = document.createElement("button");
      edit.className = "btn ghost small icon-btn";
      edit.type = "button";
      edit.title = "Edit task";
      edit.setAttribute("aria-label", "Edit task");
      edit.innerHTML = ICON_EDIT;
      edit.onclick = () => openTaskModal(t.id);

      const del = document.createElement("button");
      del.className = "btn ghost small icon-btn danger-text";
      del.type = "button";
      del.title = "Delete task";
      del.setAttribute("aria-label", "Delete task");
      del.innerHTML = ICON_DELETE;
      del.onclick = () => deleteModalTask(t);

      actions.appendChild(edit);
      actions.appendChild(del);
      head.appendChild(name);
      head.appendChild(actions);

      const info = document.createElement("div");
      info.className = "story-task-info";
      info.innerHTML =
        '<div class="story-task-badges"><span class="status-pill ' +
        escapeAttr(t.status) +
        '">' +
        escapeHtml(STATUS_LABELS[t.status] || t.status) +
        "</span>" +
        (t.category ? '<span class="story-task-badge">' + escapeHtml(t.category) + "</span>" : "") +
        (priority
          ? '<span class="story-task-badge priority-' +
            escapeAttr(priority) +
            '">' +
            escapeHtml(priority.charAt(0).toUpperCase() + priority.slice(1)) +
            " priority</span>"
          : "") +
        "</div>" +
        (t.description ? '<p class="story-task-desc">' + escapeHtml(t.description) + "</p>" : "") +
        '<div class="story-task-details">' +
        taskAssigneesDetailHtml(taskAssigneeIds(t)) +
        taskDetailHtml(
          "detail-due" + (overdue ? " overdue" : ""),
          "Due date",
          due
            ? '<span class="detail-value">' +
                ICON_CALENDAR +
                '<time datetime="' + escapeAttr(due) + '">' + escapeHtml(formatDay(due)) + "</time></span>" +
                (overdue ? '<span class="detail-note detail-overdue">Overdue</span>' : "") +
                (t.due_date ? "" : '<span class="detail-note">Story due date</span>')
            : '<span class="detail-empty">No due date</span>'
        ) +
        taskDetailHtml(
          "detail-done-when",
          "Done when",
          storyDoneWhen
            ? '<p class="detail-text">' + escapeHtml(storyDoneWhen) + '</p><span class="detail-note">From story</span>'
            : '<span class="detail-empty">Not specified</span>'
        ) +
        "</div>";

      row.appendChild(head);
      row.appendChild(info);
      list.appendChild(row);
    });
  }

  // The cards show the story's due date / Done When: keep them in step with the form.
  $("#story-due").addEventListener("change", renderStoryTaskList);
  $("#story-done-when").addEventListener("input", renderStoryTaskList);

  // Deletes a task after confirmation. Works for staged (draft) tasks too.
  async function removeTask(t, isDraft) {
    if (!confirm('Delete task "' + t.title + '"?')) return false;

    if (isDraft) {
      draftTasks = draftTasks.filter((d) => d.id !== t.id);
      renderStoryTaskList();
      return true;
    }

    const { error } = await sb.from("tasks").delete().eq("id", t.id);

    if (error) {
      toast("Couldn't delete task: " + error.message);
      return false;
    }

    tasks = tasks.filter((x) => x.id !== t.id);
    render();
    if (isStoryModalOpen()) renderStoryTaskList();
    loadAll();
    return true;
  }

  function deleteModalTask(t) {
    return removeTask(t, !editingStoryId);
  }

  // ---------- task popup ----------
  // ctx.storyId is set when a task is opened straight from the board
  // (story modal not involved); otherwise the story modal provides the context.
  function openTaskModal(taskId, ctx) {
    const fromBoard = !!(ctx && ctx.storyId);
    taskStoryId = fromBoard ? ctx.storyId : editingStoryId;
    taskIsDraft = !fromBoard && !editingStoryId;
    editingTaskId = taskId || null;

    const pool = taskIsDraft ? draftTasks : tasksForStory(taskStoryId);
    const task = taskId ? pool.find((t) => t.id === taskId) : null;
    if (taskId && !task) editingTaskId = null;

    $("#task-modal-title").textContent = task ? "Edit Task" : "New Task";
    $("#task-name").value = task ? task.title : "";
    $("#task-desc").value = task ? task.description || "" : "";
    $("#task-category").value = task && task.category ? task.category : "Feature";
    $("#task-delete").style.display = task ? "inline-block" : "none";

    // Ids of members this tab hasn't loaded stay in the list (not shown, so they
    // can't be removed here); only what the user unticks counts as a removal.
    pickerIds = task ? taskAssigneeIds(task) : [];
    pickerFromIds = task && task.assignee_ids ? task.assignee_ids.slice() : [];
    renderAssigneePicker();
    setAssigneeMenuOpen(false);
    setTaskStatusTab(task ? task.status : "in_progress");

    $("#task-overlay").style.display = "flex";
    setTimeout(() => $("#task-name").focus(), 30);
  }

  function setTaskStatusTab(status) {
    editingTaskStatus = status;

    document.querySelectorAll("#task-status-tabs .status-tab").forEach((el) => {
      el.classList.toggle("active", el.dataset.status === status);
    });
  }

  document.querySelectorAll("#task-status-tabs .status-tab").forEach((el) => {
    el.onclick = () => setTaskStatusTab(el.dataset.status);
  });

  $("#story-add-task").onclick = () => openTaskModal(null);

  $("#task-cancel").onclick = () => ($("#task-overlay").style.display = "none");

  $("#task-delete").onclick = async () => {
    if (!editingTaskId) return;

    const pool = taskIsDraft ? draftTasks : tasksForStory(taskStoryId);
    const t = pool.find((x) => x.id === editingTaskId);
    if (!t) return;

    if (await removeTask(t, taskIsDraft)) $("#task-overlay").style.display = "none";
  };

  function nextTaskPosition(storyId) {
    const inStory = tasksForStory(storyId);
    if (inStory.length === 0) return 0;
    return Math.max(...inStory.map((t) => t.position)) + 1;
  }

  $("#task-save").onclick = async () => {
    const title = $("#task-name").value.trim();

    if (!title) return toast("Give the task a name");

    const fields = {
      title,
      description: $("#task-desc").value.trim(),
      category: $("#task-category").value || "Feature",
      status: editingTaskStatus,
      assignee_id: pickerIds[0] || null, // legacy column: kept as the first assignee
    };
    const assigneeIds = pickerIds.slice();

    // Story not saved yet: stage the task locally.
    if (taskIsDraft) {
      if (editingTaskId) {
        const d = draftTasks.find((x) => x.id === editingTaskId);
        if (d) Object.assign(d, fields, { assignee_ids: assigneeIds });
      } else {
        draftTasks.push(Object.assign({ id: "draft_" + ++draftSeq }, fields, { assignee_ids: assigneeIds }));
      }
      $("#task-overlay").style.display = "none";
      renderStoryTaskList();
      return;
    }

    const saveBtn = $("#task-save");
    saveBtn.disabled = true;

    try {
      if (!(await assigneesLoadedOrWarn())) return;

      if (editingTaskId) {
        const { error } = await sb
          .from("tasks")
          .update(Object.assign({}, fields, { updated_at: new Date().toISOString() }))
          .eq("id", editingTaskId);

        if (error) return toast("Couldn't save task: " + error.message);

        const ae = await syncTaskAssignees(editingTaskId, assigneeIds, pickerFromIds);
        if (ae) return toast("Task saved, but its assignees failed: " + ae.message + ". Click Save to retry.");
      } else {
        // Only columns that exist in public.tasks:
        // title, description, category, status, assignee_id (from `fields`),
        // plus story_id, position, created_by, updated_at.
        const { data, error } = await sb
          .from("tasks")
          .insert(
            Object.assign({}, fields, {
              story_id: taskStoryId,
              position: nextTaskPosition(taskStoryId),
              created_by: currentUserName(),
              updated_at: new Date().toISOString(),
            })
          )
          .select("id")
          .single();

        if (error) return toast("Couldn't create task: " + error.message);

        const ae = await syncTaskAssignees(data.id, assigneeIds, []);
        if (ae) {
          // The task exists now: switch the popup to editing it, so Save retries
          // only the assignees instead of creating the task a second time.
          editingTaskId = data.id;
          pickerFromIds = [];
          $("#task-modal-title").textContent = "Edit Task";
          $("#task-delete").style.display = "inline-block";
          loadAll();
          return toast("Task created, but its assignees failed: " + ae.message + ". Click Save to retry.");
        }
      }

      warnIfSingleAssigneeOnly(assigneeIds);
      $("#task-overlay").style.display = "none";
      await loadAll();
    } finally {
      saveBtn.disabled = false;
    }
  };

  // ---------- save story ----------
  $("#story-save").onclick = async () => {
    const title = $("#story-title").value.trim();

    if (!title) return toast("Give the story a title");

    const payload = {
      title,
      description: $("#story-desc").value.trim(),
      function: $("#story-function").value || null,
      done_when: $("#story-done-when").value.trim() || null, // free text, null when empty
      priority: $("#story-priority").value || "medium",
      status: editingStatus,
      due_date: $("#story-due").value || null, // date column: null, never ""
      updated_at: new Date().toISOString(),
    };

    const saveBtn = $("#story-save");
    saveBtn.disabled = true;

    try {
      if (!editingStoryId && draftTasks.length && !(await assigneesLoadedOrWarn())) return;

      if (editingStoryId) {
        const { error } = await sb.from("stories").update(payload).eq("id", editingStoryId);

        if (error) return toast("Couldn't save: " + error.message);
      } else {
        payload.position = nextPosition(editingStatus);
        payload.created_by = currentUserName();

        const { data, error } = await sb.from("stories").insert(payload).select().single();

        if (error) return toast("Couldn't create story: " + error.message);

        if (draftTasks.length) {
          const rows = draftTasks.map((d, i) => ({
            title: d.title,
            description: d.description,
            category: d.category,
            status: d.status,
            assignee_id: taskAssigneeIds(d)[0] || null,
            story_id: data.id,
            position: i,
            created_by: currentUserName(),
            updated_at: new Date().toISOString(),
          }));

          const { data: saved, error: te } = await sb.from("tasks").insert(rows).select("id, position");

          if (te) {
            toast("Story saved, but its tasks failed: " + te.message);
          } else if (multiAssigneeReady) {
            // match inserted rows back to their drafts by position (= draft index)
            const links = [];
            (saved || []).forEach((r) => {
              const d = draftTasks[r.position];
              if (d) taskAssigneeIds(d).forEach((id) => links.push({ task_id: r.id, member_id: id }));
            });

            if (links.length) {
              // ignore duplicates: the database may already have added each first assignee
              const { error: ae } = await sb
                .from("task_assignees")
                .upsert(links, { onConflict: "task_id,member_id", ignoreDuplicates: true });
              if (ae) toast("Story saved, but task assignees failed: " + ae.message + ". Open its tasks to re-add them.");
            }
          } else {
            const multi = draftTasks.find((d) => taskAssigneeIds(d).length > 1);
            if (multi) warnIfSingleAssigneeOnly(taskAssigneeIds(multi));
          }
        }
      }

      closeStoryModal();
      await loadAll();
    } finally {
      saveBtn.disabled = false;
    }
  };

  // ---------- delete story ----------
  $("#story-delete").onclick = async () => {
    if (!editingStoryId) return;

    const story = storyById(editingStoryId);
    const count = tasksForStory(editingStoryId).length;
    const name = story ? '"' + story.title + '"' : "this story";
    const taskWarning = count
      ? "WARNING: its " + count + (count === 1 ? " linked task" : " linked tasks") +
        " will also be permanently deleted (ON DELETE CASCADE)."
      : "Any tasks linked to it will also be permanently deleted (ON DELETE CASCADE).";

    if (!confirm("Delete story " + name + "?\n\n" + taskWarning + "\n\nThis cannot be undone.")) return;

    const { error } = await sb.from("stories").delete().eq("id", editingStoryId);

    if (error) return toast("Couldn't delete: " + error.message);

    closeStoryModal();
    await loadAll();
  };

  function nextPosition(status) {
    const inCol = stories.filter((s) => s.status === status);

    if (inCol.length === 0) return 0;

    return Math.max(...inCol.map((s) => s.position)) + 1;
  }

  // ---------- rendering ----------
  function escapeHtml(s) {
    const d = document.createElement("div");
    d.textContent = s == null ? "" : s;
    return d.innerHTML;
  }

  function render() {
    refreshStoryFilterOptions();

    $("#whoami-chip").innerHTML =
      whoamiId && memberById(whoamiId)
        ? '<span class="avatar" style="background:' +
          safeColor(memberById(whoamiId)) +
          '">' +
          escapeHtml(initials(memberById(whoamiId).name)) +
          "</span>" +
          escapeHtml(memberById(whoamiId).name)
        : "Who are you?";

    if (!whoamiId || !memberById(whoamiId)) {
      showWhoamiModal();
    }

    boardEl.innerHTML = "";

    const orderedStories = stories
      .filter(storyMatchesFilters)
      .sort((a, b) => a.position - b.position);

    STATUSES.forEach((s) => {
      // Each column holds the STORY cards of that status. Tasks aren't drawn on
      // the board (they're opened from their story).
      const shown =
        !boardFilters.status || boardFilters.status === s.key
          ? orderedStories.filter((st) => st.status === s.key && storyMatchesTaskFilters(st))
          : [];

      const col = document.createElement("div");
      col.className = "column";
      col.dataset.status = s.key;

      const head = document.createElement("div");
      head.className = "column-head";

      head.innerHTML =
        '<div class="column-title"><span class="dot ' +
        s.key +
        '"></span>' +
        s.label +
        '</div><span class="count">' +
        shown.length +
        "</span>";

      col.appendChild(head);

      const list = document.createElement("div");
      list.className = "card-list";

      list.addEventListener("dragover", (e) => {
        e.preventDefault();
        col.classList.add("dragover");
      });

      list.addEventListener("dragleave", () => col.classList.remove("dragover"));

      list.addEventListener("drop", (e) => {
        e.preventDefault();

        col.classList.remove("dragover");

        handleDrop(s.key, list, e.clientY);
      });

      if (shown.length === 0) {
        const hint = document.createElement("div");
        hint.className = "empty-hint";
        hint.textContent = "No stories";
        list.appendChild(hint);
      }

      shown.forEach((st) => list.appendChild(renderStoryGroup(st)));

      col.appendChild(list);

      const addBtn = document.createElement("button");
      addBtn.className = "add-card-btn";
      addBtn.textContent = "+ Add Story";
      addBtn.onclick = () => openStoryModal(s.key, null);

      col.appendChild(addBtn);

      boardEl.appendChild(col);
    });
  }

  // A story on the board: just its card. (The .story-group wrapper is what
  // dropStory() measures to find the drop position.)
  function renderStoryGroup(st) {
    const group = document.createElement("div");
    group.className = "story-group";
    group.dataset.storyId = st.id;
    group.appendChild(renderCard(st));
    return group;
  }

  // Story summary header (click = edit story, drag = change the story's status)
  function renderCard(st) {
    const card = document.createElement("div");

    card.className = "card story-card";
    card.draggable = true;
    card.dataset.id = st.id;

    card.addEventListener("dragstart", () => {
      dragItem = { kind: "story", id: st.id };
      card.classList.add("dragging");
    });

    card.addEventListener("dragend", () => card.classList.remove("dragging"));

    card.addEventListener("click", () => openStoryModal(st.status, st.id));

    const assignee = st.assignee_id ? memberById(st.assignee_id) : null;

    const today = new Date().toISOString().slice(0, 10);

    const overdue = st.due_date && st.due_date < today && st.status !== "done";

    const storyTasks = tasksForStory(st.id);
    const doneCount = storyTasks.filter((t) => t.status === "done").length;
    const taskLabel = storyTasks.length
      ? storyTasks.length +
        (storyTasks.length === 1 ? " task" : " tasks") +
        (doneCount ? " · " + doneCount + " done" : "")
      : "No tasks";

    card.innerHTML =
      '<p class="card-title">' +
      escapeHtml(st.title) +
      "</p>" +
      (st.description
        ? '<p class="card-desc">' + escapeHtml(st.description) + "</p>"
        : "") +
      '<div class="card-tags">' +
      (st.function ? '<span class="tag">' + escapeHtml(normalizeFunction(st.function)) + "</span>" : "") +
      '<span class="tag dim">' +
      taskLabel +
      "</span></div>" +
      '<div class="card-meta">' +
      (assignee
        ? '<span class="card-assignee"><span class="avatar" style="background:' +
          safeColor(assignee) +
          '">' +
          escapeHtml(initials(assignee.name)) +
          "</span>" +
          escapeHtml(assignee.name) +
          "</span>"
        : '<span class="card-assignee">Unassigned</span>') +
      (st.due_date
        ? '<span class="due ' + (overdue ? "overdue" : "") + '">' + escapeHtml(st.due_date) + "</span>"
        : "<span></span>") +
      "</div>";

    return card;
  }

  // Individual task card (click = edit task, drag = change the task's status)
  function handleDrop(status, listEl, clientY) {
    const item = dragItem;
    dragItem = null;

    if (!item || item.kind !== "story") return;

    return dropStory(item.id, status, listEl, clientY);
  }

  // Dropping a story header changes the story's own status/order.
  function dropStory(id, status, listEl, clientY) {
    let insertBeforeId = null;

    for (const g of listEl.querySelectorAll(".story-group")) {
      if (g.dataset.storyId === id) continue;

      const rect = g.getBoundingClientRect();

      if (clientY < rect.top + rect.height / 2) {
        insertBeforeId = g.dataset.storyId;
        break;
      }
    }

    const colStories = stories
      .filter((s) => s.status === status && s.id !== id)
      .sort((a, b) => a.position - b.position);

    let newPos;

    const idx = insertBeforeId ? colStories.findIndex((s) => s.id === insertBeforeId) : -1;

    if (colStories.length === 0) {
      newPos = 0;
    } else if (idx < 0) {
      newPos = colStories[colStories.length - 1].position + 1;
    } else {
      const before = idx > 0 ? colStories[idx - 1].position : colStories[idx].position - 1;

      newPos = (before + colStories[idx].position) / 2;
    }

    sb.from("stories")
      .update({
        status,
        position: newPos,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .then(({ error }) => {
        if (error) {
          toast("Couldn't move story: " + error.message);
        } else {
          loadAll();
        }
      });
  }

  loadAll();
})();