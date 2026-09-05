(function () {
  const CONFIG = window.KANBAN_CONFIG || {};
  const STATUSES = [
    { key: "todo", label: "To Do" },
    { key: "in_progress", label: "In Progress" },
    { key: "done", label: "Done" },
  ];
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
  let tasks = [];
  let whoamiId = localStorage.getItem("kanban_whoami_id") || null;
  let filterMine = false;
  let editingTaskId = null;
  let editingStatus = "todo";
  let dragTaskId = null;

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

  // ---------- data loading ----------
  async function loadAll() {
    const [{ data: m, error: me }, { data: t, error: te }] = await Promise.all([
      sb.from("members").select("*").order("created_at"),
      sb.from("tasks").select("*").order("position"),
    ]);
    if (me) return toast("Couldn't load members: " + me.message);
    if (te) return toast("Couldn't load tasks: " + te.message);
    members = m || [];
    tasks = t || [];
    render();
  }

  sb
    .channel("kanban-sync")
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
    if (whoamiId && memberById(whoamiId)) $("#whoami-select").value = whoamiId;
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
    members.forEach((m) => {
      const row = document.createElement("div");
      row.className = "member-row";
      row.innerHTML =
        '<span class="avatar" style="background:' +
        m.color +
        '">' +
        initials(m.name) +
        '</span><span>' +
        escapeHtml(m.name) +
        "</span>";
      const del = document.createElement("button");
      del.className = "btn ghost small";
      del.textContent = "Remove";
      del.onclick = async () => {
        if (!confirm('Remove "' + m.name + '"? Their tasks will become unassigned.')) return;
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

  // ---------- task modal ----------
  function openTaskModal(status, taskId) {
    editingTaskId = taskId || null;
    editingStatus = status;
    const task = taskId ? tasks.find((t) => t.id === taskId) : null;

    $("#task-modal-title").textContent = task ? "Edit task" : "New task";
    $("#task-title").value = task ? task.title : "";
    $("#task-desc").value = task ? task.description || "" : "";
    $("#task-due").value = task && task.due_date ? task.due_date : "";
    $("#task-delete").style.display = task ? "inline-block" : "none";

    const assigneeSel = $("#task-assignee");
    assigneeSel.innerHTML = '<option value="">Unassigned</option>';
    members.forEach((m) => {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.name;
      assigneeSel.appendChild(opt);
    });
    assigneeSel.value = task && task.assignee_id ? task.assignee_id : "";

    setStatusTab(status);
    $("#task-overlay").style.display = "flex";
    setTimeout(() => $("#task-title").focus(), 30);
  }

  function setStatusTab(status) {
    editingStatus = status;
    document.querySelectorAll(".status-tab").forEach((el) => {
      el.classList.toggle("active", el.dataset.status === status);
    });
  }
  document.querySelectorAll(".status-tab").forEach((el) => {
    el.onclick = () => setStatusTab(el.dataset.status);
  });

  $("#task-cancel").onclick = () => ($("#task-overlay").style.display = "none");

  $("#task-save").onclick = async () => {
    const title = $("#task-title").value.trim();
    if (!title) return toast("Give the task a title");
    const payload = {
      title,
      description: $("#task-desc").value.trim(),
      status: editingStatus,
      assignee_id: $("#task-assignee").value || null,
      due_date: $("#task-due").value || null,
      updated_at: new Date().toISOString(),
    };
    if (editingTaskId) {
      const { error } = await sb.from("tasks").update(payload).eq("id", editingTaskId);
      if (error) return toast("Couldn't save: " + error.message);
    } else {
      payload.position = nextPosition(editingStatus);
      payload.created_by = whoamiId ? memberById(whoamiId).name : "someone";
      const { error } = await sb.from("tasks").insert(payload);
      if (error) return toast("Couldn't create task: " + error.message);
    }
    $("#task-overlay").style.display = "none";
  };

  $("#task-delete").onclick = async () => {
    if (!editingTaskId) return;
    if (!confirm("Delete this task?")) return;
    const { error } = await sb.from("tasks").delete().eq("id", editingTaskId);
    if (error) return toast("Couldn't delete: " + error.message);
    $("#task-overlay").style.display = "none";
  };

  function nextPosition(status) {
    const inCol = tasks.filter((t) => t.status === status);
    if (inCol.length === 0) return 0;
    return Math.max(...inCol.map((t) => t.position)) + 1;
  }

  // ---------- rendering ----------
  function escapeHtml(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  function render() {
    $("#whoami-chip").innerHTML = whoamiId && memberById(whoamiId)
      ? '<span class="avatar" style="background:' + memberById(whoamiId).color + '">' + initials(memberById(whoamiId).name) + "</span>" + escapeHtml(memberById(whoamiId).name)
      : "Who are you?";

    if (!whoamiId || !memberById(whoamiId)) {
      showWhoamiModal();
    }

    boardEl.innerHTML = "";
    STATUSES.forEach((s) => {
      let colTasks = tasks
        .filter((t) => t.status === s.key)
        .sort((a, b) => a.position - b.position);
      if (filterMine && whoamiId) colTasks = colTasks.filter((t) => t.assignee_id === whoamiId);

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
        colTasks.length +
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

      if (colTasks.length === 0) {
        const hint = document.createElement("div");
        hint.className = "empty-hint";
        hint.textContent = "No tasks";
        list.appendChild(hint);
      }

      colTasks.forEach((t) => list.appendChild(renderCard(t)));
      col.appendChild(list);

      const addBtn = document.createElement("button");
      addBtn.className = "add-card-btn";
      addBtn.textContent = "+ Add task";
      addBtn.onclick = () => openTaskModal(s.key, null);
      col.appendChild(addBtn);

      boardEl.appendChild(col);
    });
  }

  function renderCard(t) {
    const card = document.createElement("div");
    card.className = "card";
    card.draggable = true;
    card.dataset.id = t.id;

    card.addEventListener("dragstart", () => {
      dragTaskId = t.id;
      card.classList.add("dragging");
    });
    card.addEventListener("dragend", () => card.classList.remove("dragging"));
    card.addEventListener("click", () => openTaskModal(t.status, t.id));

    const assignee = t.assignee_id ? memberById(t.assignee_id) : null;
    const today = new Date().toISOString().slice(0, 10);
    const overdue = t.due_date && t.due_date < today && t.status !== "done";

    card.innerHTML =
      '<p class="card-title">' +
      escapeHtml(t.title) +
      "</p>" +
      (t.description ? '<p class="card-desc">' + escapeHtml(t.description) + "</p>" : "") +
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
      (t.due_date ? '<span class="due ' + (overdue ? "overdue" : "") + '">' + t.due_date + "</span>" : "<span></span>") +
      "</div>";
    return card;
  }

  function handleDrop(status, listEl, clientY) {
    if (!dragTaskId) return;
    const cards = Array.from(listEl.querySelectorAll(".card"));
    let insertBeforeId = null;
    for (const c of cards) {
      const rect = c.getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) {
        insertBeforeId = c.dataset.id;
        break;
      }
    }
    const colTasks = tasks
      .filter((t) => t.status === status && t.id !== dragTaskId)
      .sort((a, b) => a.position - b.position);

    let newPos;
    if (colTasks.length === 0) {
      newPos = 0;
    } else if (!insertBeforeId) {
      newPos = colTasks[colTasks.length - 1].position + 1;
    } else {
      const idx = colTasks.findIndex((t) => t.id === insertBeforeId);
      const before = idx > 0 ? colTasks[idx - 1].position : colTasks[idx].position - 1;
      const after = colTasks[idx].position;
      newPos = (before + after) / 2;
    }

    const id = dragTaskId;
    dragTaskId = null;
    sb.from("tasks")
      .update({ status, position: newPos, updated_at: new Date().toISOString() })
      .eq("id", id)
      .then(({ error }) => {
        if (error) toast("Couldn't move task: " + error.message);
      });
  }

  loadAll();
})();
