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
  let whoamiId = localStorage.getItem("kanban_whoami_id") || null;
  let filterMine = false;
  let editingStoryId = null;
  let editingStatus = "todo";
  let dragItem = null; // { kind: "task" | "story", id }

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

  function currentUserName() {
    return whoamiId && memberById(whoamiId) ? memberById(whoamiId).name : "someone";
  }

  function isStoryModalOpen() {
    return $("#story-overlay").style.display === "flex";
  }

  // ---------- data loading ----------
  async function loadAll() {
    const [mRes, sRes, tRes] = await Promise.all([
      sb.from("members").select("*").order("created_at"),
      sb.from("stories").select("*").order("position"),
      sb.from("tasks").select("*").order("position"),
    ]);

    if (mRes.error) return toast("Couldn't load members: " + mRes.error.message);
    if (sRes.error)
      return toast("Couldn't load stories: " + sRes.error.message + " (has the stories SQL migration been applied?)");
    if (tRes.error) return toast("Couldn't load tasks: " + tRes.error.message);

    members = mRes.data || [];
    stories = sRes.data || [];
    tasks = (tRes.data || []).filter((t) => t.story_id);

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

    // Count every loaded task once, under its assignee (unassigned tasks are skipped).
    const stats = {};
    tasks.forEach((t) => {
      if (!t.assignee_id) return;
      const s = stats[t.assignee_id] || (stats[t.assignee_id] = { todo: 0, in_progress: 0, done: 0 });
      if (t.status in s) s[t.status]++;
    });

    members.forEach((m) => {
      const s = stats[m.id] || { todo: 0, in_progress: 0, done: 0 };
      const total = s.todo + s.in_progress + s.done;
      const pct = total ? Math.round((s.done / total) * 100) : 0;

      const row = document.createElement("div");
      row.className = "member-row";

      row.innerHTML =
        '<span class="avatar member-avatar" style="background:' +
        m.color +
        '">' +
        initials(m.name) +
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
    if (filterMine && whoamiId && t.assignee_id !== whoamiId) return false;
    return true;
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
  function fillAssigneeOptions(selectEl, selectedId) {
    selectEl.innerHTML = '<option value="">Unassigned</option>';

    members.forEach((m) => {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.name;
      selectEl.appendChild(opt);
    });

    selectEl.value = selectedId || "";
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

    items.forEach((t) => {
      const assignee = t.assignee_id ? memberById(t.assignee_id) : null;

      const row = document.createElement("div");
      row.className = "story-task-row";
      row.dataset.status = t.status;

      const info = document.createElement("div");
      info.className = "story-task-info";
      info.innerHTML =
        '<p class="story-task-name">' +
        escapeHtml(t.title) +
        '</p><div class="story-task-meta"><span class="status-pill ' +
        t.status +
        '">' +
        (STATUS_LABELS[t.status] || t.status) +
        "</span>" +
        (t.category ? '<span class="story-task-meta-item">' + escapeHtml(t.category) + "</span>" : "") +
        (assignee
          ? '<span class="story-task-meta-item card-assignee"><span class="avatar" style="background:' +
            assignee.color +
            '">' +
            initials(assignee.name) +
            "</span>" +
            escapeHtml(assignee.name) +
            "</span>"
          : '<span class="story-task-meta-item">Unassigned</span>') +
        "</div>";

      const actions = document.createElement("div");
      actions.className = "story-task-actions";

      const edit = document.createElement("button");
      edit.className = "btn ghost small";
      edit.textContent = "Edit";
      edit.onclick = () => openTaskModal(t.id);

      const del = document.createElement("button");
      del.className = "btn ghost small danger-text";
      del.textContent = "Delete";
      del.onclick = () => deleteModalTask(t);

      actions.appendChild(edit);
      actions.appendChild(del);

      row.appendChild(info);
      row.appendChild(actions);
      list.appendChild(row);
    });
  }

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

    fillAssigneeOptions($("#task-assignee"), task ? task.assignee_id : "");
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
      assignee_id: $("#task-assignee").value || null,
    };

    // Story not saved yet: stage the task locally.
    if (taskIsDraft) {
      if (editingTaskId) {
        const d = draftTasks.find((x) => x.id === editingTaskId);
        if (d) Object.assign(d, fields);
      } else {
        draftTasks.push(Object.assign({ id: "draft_" + ++draftSeq }, fields));
      }
      $("#task-overlay").style.display = "none";
      renderStoryTaskList();
      return;
    }

    const saveBtn = $("#task-save");
    saveBtn.disabled = true;

    try {
      if (editingTaskId) {
        const { error } = await sb
          .from("tasks")
          .update(Object.assign({}, fields, { updated_at: new Date().toISOString() }))
          .eq("id", editingTaskId);

        if (error) return toast("Couldn't save task: " + error.message);
      } else {
        // Only columns that exist in public.tasks:
        // title, description, category, status, assignee_id (from `fields`),
        // plus story_id, position, created_by, updated_at.
        const { error } = await sb.from("tasks").insert(
          Object.assign({}, fields, {
            story_id: taskStoryId,
            position: nextTaskPosition(taskStoryId),
            created_by: currentUserName(),
            updated_at: new Date().toISOString(),
          })
        );

        if (error) return toast("Couldn't create task: " + error.message);
      }

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
            assignee_id: d.assignee_id,
            story_id: data.id,
            position: i,
            created_by: currentUserName(),
            updated_at: new Date().toISOString(),
          }));

          const { error: te } = await sb.from("tasks").insert(rows);

          if (te) toast("Story saved, but its tasks failed: " + te.message);
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
          memberById(whoamiId).color +
          '">' +
          initials(memberById(whoamiId).name) +
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
      // Each column holds TASKS of that status, grouped under their Story.
      // A story with no visible task here still shows (as an empty group)
      // in the column that matches the story's own status.
      const groups = [];
      let taskCount = 0;

      if (!boardFilters.status || boardFilters.status === s.key) {
        orderedStories.forEach((st) => {
          const visible = tasksForStory(st.id).filter(
            (t) => t.status === s.key && taskMatchesFilters(t)
          );

          const showEmpty =
            st.status === s.key &&
            !boardFilters.category &&
            (!filterMine || !whoamiId || st.assignee_id === whoamiId);

          if (visible.length || showEmpty) {
            groups.push({ story: st, tasks: visible });
            taskCount += visible.length;
          }
        });
      }

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
        taskCount +
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

      if (groups.length === 0) {
        const hint = document.createElement("div");
        hint.className = "empty-hint";
        hint.textContent = "No tasks";
        list.appendChild(hint);
      }

      groups.forEach((g) => list.appendChild(renderStoryGroup(g.story, g.tasks, s.key)));

      col.appendChild(list);

      const addBtn = document.createElement("button");
      addBtn.className = "add-card-btn";
      addBtn.textContent = "+ Add Story";
      addBtn.onclick = () => openStoryModal(s.key, null);

      col.appendChild(addBtn);

      boardEl.appendChild(col);
    });
  }

  function renderStoryGroup(st, visibleTasks, columnStatus) {
    const group = document.createElement("div");
    group.className = "story-group";
    group.dataset.storyId = st.id;

    // The Story card itself appears only once: in the column of its own status.
    if (st.status === columnStatus) group.appendChild(renderCard(st));

    const wrap = document.createElement("div");
    wrap.className = "group-tasks";

    if (visibleTasks.length === 0) {
      const hint = document.createElement("div");
      hint.className = "empty-hint";
      hint.textContent = "No tasks here";
      wrap.appendChild(hint);
    }

    visibleTasks.forEach((t) => wrap.appendChild(renderTaskCard(t)));

    group.appendChild(wrap);
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
          assignee.color +
          '">' +
          initials(assignee.name) +
          "</span>" +
          escapeHtml(assignee.name) +
          "</span>"
        : '<span class="card-assignee">Unassigned</span>') +
      (st.due_date
        ? '<span class="due ' + (overdue ? "overdue" : "") + '">' + st.due_date + "</span>"
        : "<span></span>") +
      "</div>";

    return card;
  }

  // Individual task card (click = edit task, drag = change the task's status)
  function renderTaskCard(t) {
    const card = document.createElement("div");

    card.className = "card task-card";
    card.draggable = true;
    card.dataset.id = t.id;

    card.addEventListener("dragstart", () => {
      dragItem = { kind: "task", id: t.id };
      card.classList.add("dragging");
    });

    card.addEventListener("dragend", () => card.classList.remove("dragging"));

    card.addEventListener("click", () => openTaskModal(t.id, { storyId: t.story_id }));

    const assignee = t.assignee_id ? memberById(t.assignee_id) : null;

    const today = new Date().toISOString().slice(0, 10);

    const overdue = t.due_date && t.due_date < today && t.status !== "done";

    card.innerHTML =
      '<p class="card-title">' +
      escapeHtml(t.title) +
      "</p>" +
      (t.description
        ? '<p class="card-desc">' + escapeHtml(t.description) + "</p>"
        : "") +
      (t.category
        ? '<div class="card-tags"><span class="tag dim">' + escapeHtml(t.category) + "</span></div>"
        : "") +
      '<div class="card-meta">' +
      (assignee
        ? '<span class="card-assignee"><span class="avatar" style="background:' +
          assignee.color +
          '">' +
          initials(assignee.name) +
          "</span>" +
          escapeHtml(assignee.name) +
          "</span>"
        : '<span class="card-assignee">Unassigned</span>') +
      (t.due_date
        ? '<span class="due ' + (overdue ? "overdue" : "") + '">' + t.due_date + "</span>"
        : "<span></span>") +
      "</div>";

    return card;
  }

  function handleDrop(status, listEl, clientY) {
    const item = dragItem;
    dragItem = null;

    if (!item) return;

    if (item.kind === "task") return dropTask(item.id, status, listEl, clientY);

    return dropStory(item.id, status, listEl, clientY);
  }

  // Dropping a task changes ONLY its status and its order. It stays in its own story.
  function dropTask(id, status, listEl, clientY) {
    const t = tasks.find((x) => x.id === id);

    if (!t) return;

    const siblings = tasksForStory(t.story_id).filter((x) => x.status === status && x.id !== id);

    let newPos = t.position;

    if (siblings.length) {
      const group = Array.from(listEl.querySelectorAll(".story-group")).find(
        (g) => g.dataset.storyId === t.story_id
      );

      let insertBeforeId = null;

      if (group) {
        for (const c of group.querySelectorAll(".task-card")) {
          if (c.dataset.id === id) continue;

          const rect = c.getBoundingClientRect();

          if (clientY < rect.top + rect.height / 2) {
            insertBeforeId = c.dataset.id;
            break;
          }
        }
      }

      const idx = insertBeforeId ? siblings.findIndex((x) => x.id === insertBeforeId) : -1;

      if (idx < 0) {
        newPos = siblings[siblings.length - 1].position + 1;
      } else {
        const before = idx > 0 ? siblings[idx - 1].position : siblings[idx].position - 1;

        newPos = (before + siblings[idx].position) / 2;
      }
    }

    sb.from("tasks")
      .update({
        status,
        position: newPos,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .then(({ error }) => {
        if (error) {
          toast("Couldn't move task: " + error.message);
        } else {
          loadAll();
        }
      });
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