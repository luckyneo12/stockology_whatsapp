function parseAgentComments(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    if (typeof raw === "string") {
      if (raw.includes("-- {")) {
        return JSON.parse(raw.substring(raw.indexOf("-- {") + 3));
      }
      const braceIdx = raw.indexOf("{");
      if (braceIdx !== -1) {
        return JSON.parse(raw.substring(braceIdx));
      }
      return JSON.parse(raw);
    }
  } catch (_) {}
  return {};
}

const router = require("express").Router();
const { query } = require("../database/dbpromise.js");
const validateUserOrAgent = require("../middlewares/userOrAgent.js");
const { checkPlan } = require("../middlewares/plan.js");
const logger = require("../utils/logger.js");

// ── Helper to resolve scope context ──────────────────────────────────────────
async function resolveScopeContext(req) {
  let dataScope = req.decode.dataScope;
  let crmUserId = req.decode.crmUserId;
  let departmentId = req.decode.departmentId;
  let teamId = req.decode.teamId;
  let scopedUserIds = req.decode.scopedUserIds || [];
  const isAgent = req.decode.role === "agent";
  const agentId = isAgent ? req.decode.userData?.id : null;
  const agentUid = req.decode.uid;
  const ownerUid = isAgent ? req.decode.owner_uid : req.decode.uid;

  let agentMeta = isAgent ? parseAgentComments(req.decode.userData?.comments) : null;
  if (agentMeta) {
    if (!dataScope) dataScope = agentMeta.dataScope;
    if (!crmUserId) crmUserId = agentMeta.crmUserId;
    if (!departmentId) departmentId = agentMeta.departmentId;
    if (!teamId) teamId = agentMeta.teamId;
  }

  // Master admin account
  if (req.decode.role === "user" && req.decode.email === "sstockology@gmail.com") {
    dataScope = "COMPANY";
  }

  // Fallback to query CRM database if dataScope is still undetermined
  if (!dataScope) {
    try {
      const crmDb = process.env.CRM_DB_NAME || "stockology_db_backup";
      const crmRows = await query(
        `SELECT cm.dataScope, cm.departmentId, cm.teamId, u.id as crmUserId 
         FROM ${crmDb}.company_members cm 
         JOIN ${crmDb}.users u ON cm.userId = u.id 
         WHERE u.email = ? LIMIT 1`,
        [req.decode.email]
      );
      if (crmRows && crmRows.length > 0) {
        dataScope = crmRows[0].dataScope;
        if (!crmUserId) crmUserId = crmRows[0].crmUserId;
        if (!departmentId) departmentId = crmRows[0].departmentId;
        if (!teamId) teamId = crmRows[0].teamId;
      }
    } catch (_) {}
  }

  if (!dataScope) {
    dataScope = isAgent ? "SELF" : "COMPANY";
  }

  const isLeader = agentMeta?.role === "MANAGER" || agentMeta?.role === "LEADER" || (req.decode.role === "user" && dataScope !== "SELF");
  const isDeptHead = agentMeta?.role === "MANAGER" || (req.decode.role === "user" && dataScope === "DEPARTMENT");

  return {
    ownerUid,
    dataScope: String(dataScope).toUpperCase(),
    crmUserId,
    departmentId,
    teamId,
    scopedUserIds,
    agentId,
    agentUid,
    isAgent,
    isLeader,
    isDeptHead,
  };
}

// ── Move card ─────────────────────────────────────────────────────────────────
router.post("/move_card", validateUserOrAgent, checkPlan, async (req, res) => {
  try {
    const scope = await resolveScopeContext(req);
    const { chatId, newLabelId, kanban_order } = req.body;

    if (!chatId) return res.json({ success: false, msg: "chatId is required" });

    const [chat] = await query(
      `SELECT id, chat_label, assigned_agent FROM beta_chats WHERE id = ? AND uid = ?`,
      [chatId, scope.ownerUid],
    );
    if (!chat) return res.json({ success: false, msg: "Chat not found" });

    // Enforce scope check on card movement
    const assignedStr = String(chat.assigned_agent || "");
    const originInstanceStr = String(chat.origin_instance_id || "");

    // Helper to check if chat origin matches user's scoped devices
    let belongsToScopeDevice = false;
    if (originInstanceStr) {
      if (scope.dataScope === "TEAM" && scope.teamId) {
        const teamInsts = await query(
          `SELECT uniqueId, number FROM instance WHERE uid = ? AND other LIKE ?`,
          [scope.ownerUid, `%"teamId":"${scope.teamId}"%`]
        );
        belongsToScopeDevice = Array.isArray(teamInsts) && teamInsts.some(
          (inst) => (inst.number && originInstanceStr.includes(inst.number)) || (inst.uniqueId && originInstanceStr.includes(inst.uniqueId))
        );
      } else if (scope.dataScope === "DEPARTMENT" && scope.departmentId) {
        const deptInsts = await query(
          `SELECT uniqueId, number FROM instance WHERE uid = ? AND other LIKE ?`,
          [scope.ownerUid, `%"departmentId":"${scope.departmentId}"%`]
        );
        belongsToScopeDevice = Array.isArray(deptInsts) && deptInsts.some(
          (inst) => (inst.number && originInstanceStr.includes(inst.number)) || (inst.uniqueId && originInstanceStr.includes(inst.uniqueId))
        );
      } else if (scope.dataScope === "SELF" && scope.crmUserId) {
        const userInsts = await query(
          `SELECT uniqueId, number FROM instance WHERE uid = ? AND other LIKE ?`,
          [scope.ownerUid, `%"assignedUserId":"${scope.crmUserId}"%`]
        );
        belongsToScopeDevice = Array.isArray(userInsts) && userInsts.some(
          (inst) => (inst.number && originInstanceStr.includes(inst.number)) || (inst.uniqueId && originInstanceStr.includes(inst.uniqueId))
        );
      }
    }

    if (scope.dataScope === "SELF") {
      const isMine =
        belongsToScopeDevice ||
        (scope.crmUserId && assignedStr.includes(`"crmUserId":"${scope.crmUserId}"`)) ||
        (scope.agentUid && assignedStr.includes(`"uid":"${scope.agentUid}"`)) ||
        (scope.agentId && (assignedStr.includes(`"id":${scope.agentId}`) || assignedStr.includes(`"id":"${scope.agentId}"`)));
      if (!isMine) {
        return res.status(403).json({ success: false, msg: "You can only manage chats assigned to you (SELF scope)." });
      }
    } else if (scope.dataScope === "TEAM") {
      const isTeam =
        belongsToScopeDevice ||
        (scope.teamId && assignedStr.includes(`"teamId":"${scope.teamId}"`)) ||
        (scope.crmUserId && assignedStr.includes(`"crmUserId":"${scope.crmUserId}"`)) ||
        (Array.isArray(scope.scopedUserIds) && scope.scopedUserIds.some((sid) => assignedStr.includes(`"crmUserId":"${sid}"`)));
      if (!isTeam && !scope.isLeader) {
        return res.status(403).json({ success: false, msg: "You can only manage chats within your TEAM scope." });
      }
    } else if (scope.dataScope === "DEPARTMENT") {
      const isDept =
        belongsToScopeDevice ||
        (scope.departmentId && assignedStr.includes(`"departmentId":"${scope.departmentId}"`)) ||
        (scope.crmUserId && assignedStr.includes(`"crmUserId":"${scope.crmUserId}"`)) ||
        (Array.isArray(scope.scopedUserIds) && scope.scopedUserIds.some((sid) => assignedStr.includes(`"crmUserId":"${sid}"`)));
      if (!isDept && !scope.isDeptHead && !scope.isLeader) {
        return res.status(403).json({ success: false, msg: "You can only manage chats within your DEPARTMENT scope." });
      }
    }

    if (!newLabelId) {
      await query(
        `UPDATE beta_chats SET chat_label = ?, kanban_order = ? WHERE id = ? AND uid = ?`,
        [JSON.stringify([]), kanban_order ?? 0, chatId, scope.ownerUid],
      );
      return res.json({ success: true });
    }

    const [newLabel] = await query(
      `SELECT * FROM chat_tags WHERE id = ? AND uid = ?`,
      [newLabelId, scope.ownerUid],
    );
    if (!newLabel) return res.json({ success: false, msg: "Label not found" });

    let existingLabels = [];
    try {
      const parsed = JSON.parse(chat.chat_label || "[]");
      existingLabels = Array.isArray(parsed) ? parsed : [parsed];
    } catch {}

    const updatedLabels = [newLabel, ...existingLabels.slice(1)];

    await query(
      `UPDATE beta_chats SET chat_label = ?, kanban_order = ? WHERE id = ? AND uid = ?`,
      [JSON.stringify(updatedLabels), kanban_order ?? 0, chatId, scope.ownerUid],
    );

    res.json({ success: true });
  } catch (err) {
    logger.error(err);
    res.json({ success: false, msg: "Something went wrong" });
  }
});

// ── Update show_on_kanban for a tag ───────────────────────────────────────────
router.post("/update_tag_kanban_visibility", validateUserOrAgent, async (req, res) => {
  try {
    const scope = await resolveScopeContext(req);
    const { labelId, show_on_kanban } = req.body;

    if (!labelId)
      return res.json({ success: false, msg: "labelId is required" });

    await query(
      `UPDATE chat_tags SET show_on_kanban = ? WHERE id = ? AND uid = ?`,
      [show_on_kanban ? 1 : 0, labelId, scope.ownerUid],
    );

    res.json({ success: true });
  } catch (err) {
    logger.error(err);
    res.json({ success: false, msg: "Something went wrong" });
  }
});

// ── Get board ─────────────────────────────────────────────────────────────────
router.post("/get_board", validateUserOrAgent, checkPlan, async (req, res) => {
  try {
    const scope = await resolveScopeContext(req);
    const {
      search = "",
      limit = 20,
      offset = 0,
      dateFilter = "lifetime",
      dateFrom = null,
      dateTo = null,
    } = req.body;

    const labels = await query(
      `SELECT * FROM chat_tags WHERE uid = ? AND show_on_kanban = 1 ORDER BY id ASC`,
      [scope.ownerUid],
    );

    let searchCondition = `WHERE uid = ?`;
    const params = [scope.ownerUid];

    // ── Apply Access Scope Filter ───────────────────────────────────────────
    if (scope.dataScope === "SELF") {
      const selfConds = [];
      if (scope.crmUserId) {
        selfConds.push(`assigned_agent LIKE ?`);
        params.push(`%"crmUserId":"${scope.crmUserId}"%`);

        try {
          const userInstances = await query(
            `SELECT uniqueId, number FROM instance WHERE uid = ? AND other LIKE ?`,
            [scope.ownerUid, `%"assignedUserId":"${scope.crmUserId}"%`]
          );
          if (Array.isArray(userInstances)) {
            for (const inst of userInstances) {
              if (inst.number) {
                selfConds.push(`origin_instance_id LIKE ?`);
                params.push(`%${inst.number}%`);
              }
              if (inst.uniqueId) {
                selfConds.push(`origin_instance_id LIKE ?`);
                params.push(`%${inst.uniqueId}%`);
              }
            }
          }
        } catch (_) {}
      }
      if (scope.agentUid) {
        selfConds.push(`assigned_agent LIKE ?`);
        params.push(`%"uid":"${scope.agentUid}"%`);
      }
      if (scope.agentId) {
        selfConds.push(`assigned_agent LIKE ? OR assigned_agent LIKE ?`);
        params.push(`%"id":${scope.agentId}%`, `%"id":"${scope.agentId}"%`);
      }
      if (selfConds.length > 0) {
        searchCondition += ` AND (${selfConds.join(" OR ")})`;
      } else {
        searchCondition += ` AND 1 = 0`;
      }
    } else if (scope.dataScope === "TEAM") {
      const teamConds = [];
      if (scope.isLeader) {
        if (scope.teamId) {
          teamConds.push(`assigned_agent LIKE ?`);
          params.push(`%"teamId":"${scope.teamId}"%`);

          // Include unassigned chats from all devices assigned to this team
          try {
            const teamInstances = await query(
              `SELECT uniqueId, number FROM instance WHERE uid = ? AND other LIKE ?`,
              [scope.ownerUid, `%"teamId":"${scope.teamId}"%`]
            );
            if (Array.isArray(teamInstances)) {
              for (const inst of teamInstances) {
                if (inst.number) {
                  teamConds.push(`origin_instance_id LIKE ? AND (assigned_agent IS NULL OR assigned_agent = 'null' OR assigned_agent = '[]' OR assigned_agent = '' OR assigned_agent LIKE '%"unassigned":true%')`);
                  params.push(`%${inst.number}%`);
                }
                if (inst.uniqueId) {
                  teamConds.push(`origin_instance_id LIKE ? AND (assigned_agent IS NULL OR assigned_agent = 'null' OR assigned_agent = '[]' OR assigned_agent = '' OR assigned_agent LIKE '%"unassigned":true%')`);
                  params.push(`%${inst.uniqueId}%`);
                }
              }
            }
          } catch (_) {}
        }
        if (scope.crmUserId) {
          teamConds.push(`assigned_agent LIKE ?`);
          params.push(`%"crmUserId":"${scope.crmUserId}"%`);
        }
        if (Array.isArray(scope.scopedUserIds) && scope.scopedUserIds.length > 0) {
          for (const sid of scope.scopedUserIds) {
            teamConds.push(`assigned_agent LIKE ?`);
            params.push(`%"crmUserId":"${sid}"%`);
          }
        }
      } else {
        // Non-leader: strictly own assigned cards only!
        if (scope.crmUserId) {
          teamConds.push(`assigned_agent LIKE ?`);
          params.push(`%"crmUserId":"${scope.crmUserId}"%`);
        }
        if (scope.agentUid) {
          teamConds.push(`assigned_agent LIKE ?`);
          params.push(`%"uid":"${scope.agentUid}"%`);
        }
        if (scope.agentId) {
          teamConds.push(`assigned_agent LIKE ? OR assigned_agent LIKE ?`);
          params.push(`%"id":${scope.agentId}%`, `%"id":"${scope.agentId}"%`);
        }
      }

      if (teamConds.length > 0) {
        searchCondition += ` AND (${teamConds.join(" OR ")})`;
      } else {
        searchCondition += ` AND 1 = 0`;
      }
    } else if (scope.dataScope === "DEPARTMENT") {
      const deptConds = [];
      if (scope.isDeptHead || scope.isLeader) {
        if (scope.departmentId) {
          deptConds.push(`assigned_agent LIKE ?`);
          params.push(`%"departmentId":"${scope.departmentId}"%`);

          try {
            const deptInstances = await query(
              `SELECT uniqueId, number FROM instance WHERE uid = ? AND other LIKE ?`,
              [scope.ownerUid, `%"departmentId":"${scope.departmentId}"%`]
            );
            if (Array.isArray(deptInstances)) {
              for (const inst of deptInstances) {
                if (inst.number) {
                  deptConds.push(`origin_instance_id LIKE ? AND (assigned_agent IS NULL OR assigned_agent = 'null' OR assigned_agent = '[]' OR assigned_agent = '' OR assigned_agent LIKE '%"unassigned":true%')`);
                  params.push(`%${inst.number}%`);
                }
                if (inst.uniqueId) {
                  deptConds.push(`origin_instance_id LIKE ? AND (assigned_agent IS NULL OR assigned_agent = 'null' OR assigned_agent = '[]' OR assigned_agent = '' OR assigned_agent LIKE '%"unassigned":true%')`);
                  params.push(`%${inst.uniqueId}%`);
                }
              }
            }
          } catch (_) {}
        }
        if (scope.crmUserId) {
          deptConds.push(`assigned_agent LIKE ?`);
          params.push(`%"crmUserId":"${scope.crmUserId}"%`);
        }
        if (Array.isArray(scope.scopedUserIds) && scope.scopedUserIds.length > 0) {
          for (const sid of scope.scopedUserIds) {
            deptConds.push(`assigned_agent LIKE ?`);
            params.push(`%"crmUserId":"${sid}"%`);
          }
        }
      } else {
        if (scope.crmUserId) {
          deptConds.push(`assigned_agent LIKE ?`);
          params.push(`%"crmUserId":"${scope.crmUserId}"%`);
        }
        if (scope.agentUid) {
          deptConds.push(`assigned_agent LIKE ?`);
          params.push(`%"uid":"${scope.agentUid}"%`);
        }
        if (scope.agentId) {
          deptConds.push(`assigned_agent LIKE ? OR assigned_agent LIKE ?`);
          params.push(`%"id":${scope.agentId}%`, `%"id":"${scope.agentId}"%`);
        }
      }

      if (deptConds.length > 0) {
        searchCondition += ` AND (${deptConds.join(" OR ")})`;
      } else {
        searchCondition += ` AND 1 = 0`;
      }
    }

    // ── Date filter ──────────────────────────────────────────────────────────
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const toDateStr = (d) =>
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

    if (dateFilter === "today") {
      const today = toDateStr(now);
      searchCondition += ` AND DATE(updatedAt) = ?`;
      params.push(today);
    } else if (dateFilter === "yesterday") {
      const yest = new Date(now);
      yest.setDate(yest.getDate() - 1);
      searchCondition += ` AND DATE(updatedAt) = ?`;
      params.push(toDateStr(yest));
    } else if (dateFilter === "last7") {
      searchCondition += ` AND updatedAt >= DATE_SUB(NOW(), INTERVAL 7 DAY)`;
    } else if (dateFilter === "last30") {
      searchCondition += ` AND updatedAt >= DATE_SUB(NOW(), INTERVAL 30 DAY)`;
    } else if (dateFilter === "thisMonth") {
      searchCondition += ` AND MONTH(updatedAt) = MONTH(NOW()) AND YEAR(updatedAt) = YEAR(NOW())`;
    } else if (dateFilter === "custom" && dateFrom && dateTo) {
      searchCondition += ` AND DATE(updatedAt) BETWEEN ? AND ?`;
      params.push(dateFrom, dateTo);
    }

    if (search) {
      searchCondition += ` AND (
        sender_name LIKE ? OR
        sender_mobile LIKE ? OR
        last_message LIKE ? OR
        chat_label LIKE ?
      )`;
      params.push(
        `%${search}%`,
        `%${search}%`,
        `%${search}%`,
        `%"title":"%${search}%"%`,
      );
    }

    const [{ total }] = await query(
      `SELECT COUNT(*) as total FROM beta_chats ${searchCondition}`,
      params,
    );

    const chats = await query(
      `SELECT id, chat_id, sender_name, sender_mobile, last_message,
              origin, unread_count, assigned_agent, chat_label, kanban_order, updatedAt
       FROM beta_chats ${searchCondition}
       ORDER BY kanban_order ASC, updatedAt DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    const parsedChats = chats.map((chat) => {
      try {
        chat.last_message = JSON.parse(chat.last_message);
      } catch {}
      return chat;
    });

    // Enrich parsedChats with CRM lead names and normalize phone numbers
    try {
      const crmDb = process.env.CRM_DB_NAME || "stockology_db_backup";
      const mobileList = parsedChats
        .map((c) => {
          const d = String(c.sender_mobile || "").replace(/\D/g, "");
          return d.length >= 10 ? d.slice(-10) : d;
        })
        .filter((d) => d && d.length >= 7);

      if (mobileList.length > 0) {
        const placeholders = mobileList.map(() => "?").join(",");
        const crmLeads = await query(
          `SELECT name, phone FROM ${crmDb}.crm_leads WHERE RIGHT(phone, 10) IN (${placeholders})`,
          mobileList
        );

        if (Array.isArray(crmLeads)) {
          const leadMap = new Map();
          for (const l of crmLeads) {
            const digits = String(l.phone || "").replace(/\D/g, "").slice(-10);
            if (digits) leadMap.set(digits, l.name);
          }

          for (const chat of parsedChats) {
            const digits = String(chat.sender_mobile || "").replace(/\D/g, "");
            const last10 = digits.slice(-10);
            if (digits.length === 10) {
              chat.sender_mobile = "91" + digits;
            }
            if (leadMap.has(last10)) {
              chat.sender_name = leadMap.get(last10);
            }
          }
        }
      }
    } catch (crmErr) {
      console.warn("CRM lead enrichment error in kaban /get_board:", crmErr.message);
    }

    const grouped = {};
    labels.forEach((l) => (grouped[l.id] = []));
    grouped["unlabeled"] = [];

    parsedChats.forEach((chat) => {
      let firstLabel = null;
      try {
        const arr = JSON.parse(
          typeof chat.chat_label === "string" ? chat.chat_label : "[]",
        );
        firstLabel = (Array.isArray(arr) ? arr : [arr])[0] || null;
      } catch {}

      if (firstLabel && grouped[firstLabel.id] !== undefined) {
        grouped[firstLabel.id].push({ ...chat, kanbanLabel: firstLabel });
      } else {
        grouped["unlabeled"].push({ ...chat, kanbanLabel: null });
      }
    });

    res.json({
      success: true,
      labels,
      grouped,
      total,
      offset,
      limit,
      scope: {
        dataScope: scope.dataScope,
        departmentId: scope.departmentId,
        teamId: scope.teamId,
      },
    });
  } catch (err) {
    logger.error(err);
    res.json({ success: false, msg: "Something went wrong" });
  }
});

module.exports = router;
