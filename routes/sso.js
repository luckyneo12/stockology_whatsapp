const router = require("express").Router();
const { query } = require("../database/dbpromise.js");
const randomstring = require("randomstring");
const bcrypt = require("bcrypt");
const { sign } = require("jsonwebtoken");

// GET /api/sso/plans - Return all available plans for CRM allocation
router.get("/plans", async (req, res) => {
  try {
    const plans = await query("SELECT * FROM plan ORDER BY id ASC");
    res.json({ success: true, plans });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/sso/plans - Create a new plan from CRM
router.post("/plans", async (req, res) => {
  try {
    const { secret, ...payload } = req.body;
    const expectedSecret = process.env.SSO_SECRET || process.env.JWTKEY;
    if (secret && secret !== expectedSecret) {
      return res.status(401).json({ success: false, msg: "Unauthorized" });
    }

    const {
      title,
      short_description,
      allow_tag,
      allow_note,
      allow_chatbot,
      contact_limit,
      allow_api,
      is_trial,
      price,
      price_strike,
      plan_duration_in_days,
      qr_account,
      wa_warmer,
      rest_api_qr,
      instagram_inbox,
      telegram_inbox,
      allow_wa_forms,
    } = payload;

    if (!title) {
      return res.status(400).json({ success: false, msg: "Plan title is required" });
    }

    const result = await query(
      `INSERT INTO plan (title, short_description, allow_tag, allow_note, allow_chatbot, 
        contact_limit, allow_api, is_trial, price, price_strike, plan_duration_in_days, 
        qr_account, wa_warmer, rest_api_qr, instagram_inbox, telegram_inbox, allow_wa_forms) 
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        title,
        short_description || "",
        allow_tag ? 1 : 0,
        allow_note ? 1 : 0,
        allow_chatbot ? 1 : 0,
        parseInt(contact_limit || 1000),
        allow_api ? 1 : 0,
        is_trial ? 1 : 0,
        is_trial ? 0 : parseInt(price || 0),
        price_strike || null,
        parseInt(plan_duration_in_days || 365),
        parseInt(qr_account || 1),
        wa_warmer ? 1 : 0,
        rest_api_qr ? 1 : 0,
        instagram_inbox ? 1 : 0,
        telegram_inbox ? 1 : 0,
        allow_wa_forms ? 1 : 0,
      ]
    );

    const inserted = await query("SELECT * FROM plan WHERE id = ?", [result.insertId]);
    res.json({ success: true, plan: inserted[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/sso/plans/:id - Update an existing plan from CRM
router.put("/plans/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { secret, ...payload } = req.body;
    const expectedSecret = process.env.SSO_SECRET || process.env.JWTKEY;
    if (secret && secret !== expectedSecret) {
      return res.status(401).json({ success: false, msg: "Unauthorized" });
    }

    const {
      title,
      short_description,
      allow_tag,
      allow_note,
      allow_chatbot,
      contact_limit,
      allow_api,
      is_trial,
      price,
      price_strike,
      plan_duration_in_days,
      qr_account,
      wa_warmer,
      rest_api_qr,
      instagram_inbox,
      telegram_inbox,
      allow_wa_forms,
    } = payload;

    await query(
      `UPDATE plan SET 
        title = ?, short_description = ?, allow_tag = ?, allow_note = ?,
        allow_chatbot = ?, contact_limit = ?, allow_api = ?, is_trial = ?,
        price = ?, price_strike = ?, plan_duration_in_days = ?,
        qr_account = ?, wa_warmer = ?, rest_api_qr = ?,
        instagram_inbox = ?, telegram_inbox = ?,
        allow_wa_forms = ?
       WHERE id = ?`,
      [
        title,
        short_description || "",
        allow_tag ? 1 : 0,
        allow_note ? 1 : 0,
        allow_chatbot ? 1 : 0,
        parseInt(contact_limit || 0),
        allow_api ? 1 : 0,
        is_trial ? 1 : 0,
        is_trial ? 0 : parseInt(price || 0),
        price_strike || null,
        parseInt(plan_duration_in_days || 1),
        parseInt(qr_account || 0),
        wa_warmer ? 1 : 0,
        rest_api_qr ? 1 : 0,
        instagram_inbox ? 1 : 0,
        telegram_inbox ? 1 : 0,
        allow_wa_forms ? 1 : 0,
        id,
      ]
    );

    const updated = await query("SELECT * FROM plan WHERE id = ?", [id]);
    res.json({ success: true, plan: updated[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/sso/plans/:id - Delete a plan from CRM
router.delete("/plans/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await query("DELETE FROM plan WHERE id = ?", [id]);
    res.json({ success: true, msg: "Plan deleted" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/sso/auth - Unified SSO session creator
router.post("/auth", async (req, res) => {
  try {
    const { email, name, role, secret, parentEmail, parentName, planTitle, planId } = req.body;

    const expectedSecret = process.env.SSO_SECRET || process.env.JWTKEY;
    if (!secret || secret !== expectedSecret) {
      return res.status(401).json({ success: false, msg: "Unauthorized SSO request" });
    }

    if (!email) {
      return res.status(400).json({ success: false, msg: "Email is required" });
    }

    const targetRole = role === "admin" ? "admin" : role === "agent" ? "agent" : "user";

    // ── Helper: Resolve Plan Object ──────────────────────────────────────────
    async function resolvePlan(reqTitle, reqId) {
      let matched = null;
      if (reqId) {
        const byId = await query("SELECT * FROM plan WHERE id = ? LIMIT 1", [reqId]);
        if (byId.length > 0) matched = byId[0];
      }
      if (!matched && reqTitle) {
        const byTitle = await query("SELECT * FROM plan WHERE LOWER(title) LIKE LOWER(?) ORDER BY id DESC LIMIT 1", [`%${reqTitle}%`]);
        if (byTitle.length > 0) matched = byTitle[0];
      }
      if (!matched) {
        const fallback = await query("SELECT * FROM plan ORDER BY id DESC LIMIT 1", []);
        if (fallback.length > 0) matched = fallback[0];
      }
      if (!matched) {
        return JSON.stringify({
          title: "CRM Platinum Plan",
          allow_tag: 1,
          allow_note: 1,
          allow_chatbot: 1,
          contact_limit: "50000",
          allow_api: 1,
          qr_account: 24,
          wa_warmer: 1,
          rest_api_qr: 1,
          allow_wa_forms: 1
        });
      }
      // Return JSON string of plan object
      return typeof matched.plan === "string" ? matched.plan : JSON.stringify(matched);
    }

    // ── Admin SSO ─────────────────────────────────────────────────────────────
    if (targetRole === "admin") {
      let admins = await query("SELECT * FROM admin WHERE email = ?", [email]);
      if (admins.length === 0) {
        admins = await query("SELECT * FROM admin LIMIT 1", []);
      }
      if (admins.length > 0) {
        const token = sign(
          { uid: admins[0].uid, role: "admin", email: admins[0].email, tokenVersion: admins[0].tokenVersion || 0 },
          process.env.JWTKEY,
          {}
        );
        return res.json({ success: true, token, role: "admin", uid: admins[0].uid, redirect: "/admin" });
      }
    }

    // ── Agent (Telecaller / Executive under Team Head) ────────────────────────
    if (targetRole === "agent") {
      let ownerUid = null;
      if (parentEmail) {
        const parentUser = await query("SELECT uid FROM user WHERE email = ?", [parentEmail]);
        if (parentUser.length > 0) {
          ownerUid = parentUser[0].uid;
        } else {
          // Auto-provision parent Team Leader account so agent is correctly linked
          const parentUid = randomstring.generate(32);
          const parentPass = await bcrypt.hash(randomstring.generate(16), 10);
          const defaultPlanJson = await resolvePlan("Platinum", null);
          const planExpire = String(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000);
          await query(
            "INSERT INTO user (role, uid, name, email, password, plan, plan_expire, trial, createdAt) VALUES ('user', ?, ?, ?, ?, ?, ?, 0, NOW())",
            [parentUid, parentName || parentEmail.split("@")[0], parentEmail, parentPass, defaultPlanJson, planExpire]
          );
          ownerUid = parentUid;
        }
      }

      if (!ownerUid) {
        const firstUser = await query("SELECT uid FROM user LIMIT 1", []);
        if (firstUser.length > 0) ownerUid = firstUser[0].uid;
      }

      let agents = await query("SELECT * FROM agents WHERE email = ?", [email]);
      let agent;
      if (agents.length === 0) {
        const agentUid = randomstring.generate(32);
        const pass = await bcrypt.hash(randomstring.generate(16), 10);
        await query(
          "INSERT INTO agents (owner_uid, uid, role, email, password, name, is_active, allow_send_new_qr, mask_number, createdAt) VALUES (?, ?, 'agent', ?, ?, ?, 1, 0, 1, NOW())",
          [ownerUid, agentUid, email, pass, name || "Agent"]
        );
        const created = await query("SELECT * FROM agents WHERE uid = ?", [agentUid]);
        agent = created[0];
      } else {
        agent = agents[0];
        if (ownerUid && agent.owner_uid !== ownerUid) {
          await query("UPDATE agents SET owner_uid = ?, name = ? WHERE uid = ?", [ownerUid, name || agent.name, agent.uid]);
          agent.owner_uid = ownerUid;
        }
      }

      const token = sign(
        {
          uid: agent.uid,
          role: "agent",
          email: agent.email,
          owner_uid: agent.owner_uid,
          tokenVersion: agent.tokenVersion || 0,
        },
        process.env.JWTKEY,
        {}
      );

      return res.json({
        success: true,
        token,
        role: "agent",
        uid: agent.uid,
        owner_uid: agent.owner_uid,
        redirect: "/agent"
      });
    }

    // ── User (Team Leader / Department Manager / Account Owner) ───────────────
    let users = await query("SELECT * FROM user WHERE email = ?", [email]);
    let user;
    const planJson = await resolvePlan(planTitle, planId);

    if (users.length === 0) {
      const uid = randomstring.generate(32);
      const defaultPassword = await bcrypt.hash(randomstring.generate(16), 10);
      const planExpire = String(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000);

      await query(
        "INSERT INTO user (role, uid, name, email, password, plan, plan_expire, trial, createdAt) VALUES ('user', ?, ?, ?, ?, ?, ?, 0, NOW())",
        [uid, name || "Team Leader", email, defaultPassword, planJson, planExpire]
      );

      const created = await query("SELECT * FROM user WHERE uid = ?", [uid]);
      user = created[0];
    } else {
      user = users[0];
      // Sync name & plan if specified
      if (planTitle || planId) {
        await query("UPDATE user SET plan = ?, name = ? WHERE uid = ?", [planJson, name || user.name, user.uid]);
      }
    }

    const token = sign(
      {
        uid: user.uid,
        role: "user",
        tokenVersion: user.tokenVersion || 0,
      },
      process.env.JWTKEY,
      { expiresIn: "7d" }
    );

    return res.json({
      success: true,
      token,
      role: "user",
      uid: user.uid,
      redirect: "/user"
    });
  } catch (err) {
    console.error("SSO Auth Error:", err);
    res.status(500).json({ success: false, msg: "SSO Error", error: err.message });
  }
});


// ── DEVICE / INSTANCE MANAGEMENT & ALLOCATION ENDPOINTS ───────────────────
const { createSession, getSession, deleteSession } = require("../helper/addon/qr/index.js");

// GET /api/sso/devices - Return all WhatsApp connected instances
router.get("/devices", async (req, res) => {
  try {
    const instances = await query("SELECT * FROM instance ORDER BY id DESC");
    for (const inst of instances) {
      const session = getSession(inst.uniqueId);
      if (!session && inst.status === "CONNECTED") {
        await query("UPDATE instance SET status = 'INACTIVE' WHERE id = ?", [inst.id]);
        inst.status = "INACTIVE";
      } else if (session && session.user && inst.status !== "CONNECTED") {
        await query("UPDATE instance SET status = 'CONNECTED' WHERE id = ?", [inst.id]);
        inst.status = "CONNECTED";
      }
    }
    res.json({ success: true, devices: instances });
  } catch (err) {
    console.error("Error fetching devices:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/sso/devices/create - Create a new instance and start Baileys QR generation
router.post("/devices/create", async (req, res) => {
  try {
    const { title, departmentId, departmentName, departmentHead, teamId, teamName, teamLeader, assignedUserId, assignedUserName, secret } = req.body;
    const expectedSecret = process.env.SSO_SECRET || process.env.JWTKEY;
    if (secret && secret !== expectedSecret) {
      return res.status(401).json({ success: false, msg: "Unauthorized" });
    }
    if (!title) {
      return res.status(400).json({ success: false, msg: "Device title is required" });
    }

    const uniqueId = randomstring.generate({ length: 8, charset: "alphanumeric" });
    let ownerUid = null;
    const users = await query("SELECT uid FROM user ORDER BY id ASC LIMIT 1");
    if (users.length > 0) ownerUid = users[0].uid;

    const otherData = JSON.stringify({
      departmentId: departmentId || null,
      departmentName: departmentName || null,
      departmentHead: departmentHead || null,
      teamId: teamId || null,
      teamName: teamName || null,
      teamLeader: teamLeader || null,
      assignedUserId: assignedUserId || null,
      assignedUserName: assignedUserName || null,
    });

    await query(
      "INSERT INTO instance (uid, title, uniqueId, status, other, createdAt) VALUES (?, ?, ?, 'GENERATING', ?, NOW())",
      [ownerUid, title, uniqueId, otherData]
    );

    // Trigger QR session generation
    try {
      await createSession(uniqueId, title.length > 20 ? title.slice(0, 20) : title);
    } catch (qrErr) {
      console.warn("createSession notice:", qrErr.message);
    }

    const inserted = await query("SELECT * FROM instance WHERE uniqueId = ?", [uniqueId]);
    res.json({ success: true, device: inserted[0] });
  } catch (err) {
    console.error("Error creating device instance:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/sso/devices/:uniqueId/status - Check real-time QR and connection status
router.get("/devices/:uniqueId/status", async (req, res) => {
  try {
    const { uniqueId } = req.params;
    const instances = await query("SELECT * FROM instance WHERE uniqueId = ? LIMIT 1", [uniqueId]);
    if (instances.length === 0) {
      return res.status(404).json({ success: false, msg: "Device not found" });
    }
    const inst = instances[0];
    const session = getSession(uniqueId);
    let isConnected = false;
    if (session) {
      try {
        isConnected = Boolean(session.user);
      } catch (_) {}
    }
    res.json({
      success: true,
      status: inst.status,
      number: inst.number,
      qr: inst.qr,
      isConnected,
      device: inst
    });
  } catch (err) {
    console.error("Error checking device status:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/sso/devices/assign - Update department and team allocation for an instance
router.post("/devices/assign", async (req, res) => {
  try {
    const { uniqueId, departmentId, departmentName, departmentHead, teamId, teamName, teamLeader, assignedUserId, assignedUserName, secret } = req.body;
    const expectedSecret = process.env.SSO_SECRET || process.env.JWTKEY;
    if (secret && secret !== expectedSecret) {
      return res.status(401).json({ success: false, msg: "Unauthorized" });
    }
    const instances = await query("SELECT * FROM instance WHERE uniqueId = ? LIMIT 1", [uniqueId]);
    if (instances.length === 0) {
      return res.status(404).json({ success: false, msg: "Device not found" });
    }

    let existingOther = {};
    try {
      existingOther = instances[0].other ? JSON.parse(instances[0].other) : {};
    } catch (_) {}

    const updatedOther = JSON.stringify({
      ...existingOther,
      departmentId: departmentId !== undefined ? departmentId : existingOther.departmentId,
      departmentName: departmentName !== undefined ? departmentName : existingOther.departmentName,
      departmentHead: departmentHead !== undefined ? departmentHead : existingOther.departmentHead,
      teamId: teamId !== undefined ? teamId : existingOther.teamId,
      teamName: teamName !== undefined ? teamName : existingOther.teamName,
      teamLeader: teamLeader !== undefined ? teamLeader : existingOther.teamLeader,
      assignedUserId: assignedUserId !== undefined ? assignedUserId : existingOther.assignedUserId,
      assignedUserName: assignedUserName !== undefined ? assignedUserName : existingOther.assignedUserName,
    });

    await query("UPDATE instance SET other = ? WHERE uniqueId = ?", [updatedOther, uniqueId]);
    const updated = await query("SELECT * FROM instance WHERE uniqueId = ?", [uniqueId]);
    res.json({ success: true, device: updated[0] });
  } catch (err) {
    console.error("Error assigning device:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/sso/devices/:uniqueId - Disconnect and delete instance
router.delete("/devices/:uniqueId", async (req, res) => {
  try {
    const { uniqueId } = req.params;
    const { secret } = req.body || {};
    const expectedSecret = process.env.SSO_SECRET || process.env.JWTKEY;
    if (secret && secret !== expectedSecret) {
      return res.status(401).json({ success: false, msg: "Unauthorized" });
    }
    const session = getSession(uniqueId);
    if (session) {
      try {
        await session.logout();
      } catch (_) {}
      try {
        deleteSession(uniqueId);
      } catch (_) {}
    }
    await query("DELETE FROM instance WHERE uniqueId = ?", [uniqueId]);
    res.json({ success: true, msg: "WhatsApp instance deleted successfully" });
  } catch (err) {
    console.error("Error deleting device instance:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/sso/sync-chat-assignments - Bulk evaluate and sync existing chats with CRM leads
router.post("/sync-chat-assignments", async (req, res) => {
  try {
    const { secret } = req.body || {};
    const expectedSecret = process.env.SSO_SECRET || process.env.JWTKEY;
    if (secret && secret !== expectedSecret) {
      return res.status(401).json({ success: false, msg: "Unauthorized" });
    }

    const crmDb = process.env.CRM_DB_NAME || "stockology_db_backup";
    const chats = await query(
      "SELECT id, uid, chat_id, sender_mobile, assigned_agent FROM beta_chats WHERE sender_mobile IS NOT NULL AND sender_mobile != 'NA'"
    );

    let updatedCount = 0;
    for (const c of chats) {
      const digitsOnly = String(c.sender_mobile).replace(/\D/g, "");
      const last10 = digitsOnly.length >= 10 ? digitsOnly.slice(-10) : digitsOnly;
      if (!last10 || last10.length < 7) continue;

      const leads = await query(
        "SELECT id, name, phone, assignedTo FROM " + crmDb + ".crm_leads WHERE phone LIKE ? ORDER BY updatedAt DESC LIMIT 1",
        ["%" + last10 + "%"]
      );

      if (leads && leads.length > 0 && leads[0].assignedTo) {
        const lead = leads[0];
        const agents = await query(
          "SELECT id, uid, name, email, comments FROM agents WHERE comments LIKE ? LIMIT 1",
          ['%"crmUserId":"' + lead.assignedTo + '"%']
        );

        if (agents && agents.length > 0) {
          const ag = agents[0];
          let agComments = {};
          try {
            agComments = typeof ag.comments === "string" ? JSON.parse(ag.comments) : ag.comments || {};
          } catch (_) {}

          const payload = JSON.stringify([
            {
              id: ag.id,
              uid: ag.uid,
              name: ag.name,
              email: ag.email,
              crmUserId: lead.assignedTo,
              leadId: lead.id,
              teamId: agComments.teamId || null,
              teamName: agComments.teamName || null,
            },
          ]);

          await query("UPDATE beta_chats SET assigned_agent = ? WHERE id = ?", [payload, c.id]);
          updatedCount++;
        }
      }
    }

    res.json({
      success: true,
      msg: `Synced ${updatedCount} chats with CRM lead owners out of ${chats.length} chats`,
      updatedCount,
      totalChats: chats.length,
    });
  } catch (err) {
    console.error("Error syncing chat assignments:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});


// POST /api/sso/sync-crm-users - Sync all CRM users & hierarchy to agents table under sstockology@gmail.com
router.post("/sync-crm-users", async (req, res) => {
  let rootPool = null;
  try {
    const mysql = require("mysql2/promise");
    const dbHost = process.env.DBHOST || "127.0.0.1";
    const dbPort = Number(process.env.DBPORT) || 3306;
    const rootUser = process.env.CRM_DB_USER || "root";
    const rootPass = process.env.CRM_DB_PASS || "Admin@123456";
    const crmDb = process.env.CRM_DB_NAME || "stockology_db_backup";
    const whatscrmDb = process.env.DBNAME || "stockology_whatscrm";

    rootPool = mysql.createPool({
      host: dbHost,
      port: dbPort,
      user: rootUser,
      password: rootPass,
      database: whatscrmDb,
    });

    // 1. Master user sstockology@gmail.com
    const [masterUsers] = await rootPool.query("SELECT uid FROM user WHERE email = \x27sstockology@gmail.com\x27");
    if (!masterUsers || masterUsers.length === 0) {
      return res.status(404).json({ success: false, error: "Master user sstockology@gmail.com not found" });
    }
    const masterUid = masterUsers[0].uid;

    // 2. Clean up non-master users from user table
    await rootPool.query("DELETE FROM user WHERE email != \x27sstockology@gmail.com\x27");

    // 3. Query all CRM members joined with users, departments, and teams
    const [members] = await rootPool.query(`
      SELECT 
        cm.id as memberId,
        cm.role as memberRole,
        cm.status as memberStatus,
        u.id as crmUserId,
        u.fullName as name,
        u.email as email,
        u.phone as phone,
        cd.id as departmentId,
        cd.name as departmentName,
        u_head.fullName as departmentHead,
        ct.id as teamId,
        ct.name as teamName,
        u_lead.fullName as teamLeader
      FROM ${crmDb}.company_members cm
      JOIN ${crmDb}.users u ON cm.userId = u.id
      LEFT JOIN ${crmDb}.company_departments cd ON cm.departmentId = cd.id
      LEFT JOIN ${crmDb}.users u_head ON cd.headId = u_head.id
      LEFT JOIN ${crmDb}.company_teams ct ON cm.teamId = ct.id
      LEFT JOIN ${crmDb}.users u_lead ON ct.leaderId = u_lead.id
    `);

    const crypto = require("crypto");
    const defaultPassword = await bcrypt.hash("Stockology@2026", 10);
    let syncedActive = 0;
    let syncedInactive = 0;

    for (const m of members) {
      if (!m.email) continue;
      const isActive = m.memberStatus === "ACTIVE" ? 1 : 0;
      if (isActive) syncedActive++;
      else syncedInactive++;

      const deptDisplay = m.departmentName ? (m.departmentHead ? `${m.departmentName} (Head: ${m.departmentHead})` : m.departmentName) : "General";
      const teamDisplay = m.teamName ? (m.teamLeader ? `${m.teamName} (Lead: ${m.teamLeader})` : m.teamName) : "No Team";

      const meta = {
        crmUserId: m.crmUserId,
        departmentId: m.departmentId || null,
        departmentName: m.departmentName || null,
        departmentHead: m.departmentHead || null,
        teamId: m.teamId || null,
        teamName: m.teamName || null,
        teamLeader: m.teamLeader || null,
        role: m.memberRole || "MEMBER",
        status: m.memberStatus || "ACTIVE",
      };

      const readableComment = `🏢 ${deptDisplay} | 👥 ${teamDisplay} | ${m.memberRole} | ${m.memberStatus} -- ${JSON.stringify(meta)}`;

      const [existing] = await rootPool.query("SELECT id FROM agents WHERE email = ?", [m.email]);
      if (existing && existing.length > 0) {
        await rootPool.query(
          "UPDATE agents SET owner_uid = ?, name = ?, mobile = ?, is_active = ?, comments = ? WHERE id = ?",
          [masterUid, m.name || "Agent", m.phone || "", isActive, readableComment, existing[0].id]
        );
      } else {
        const agentUid = crypto.randomBytes(16).toString("hex");
        await rootPool.query(
          "INSERT INTO agents (owner_uid, uid, role, email, password, name, mobile, comments, is_active, allow_send_new_qr, mask_number, createdAt) VALUES (?, ?, \x27agent\x27, ?, ?, ?, ?, ?, ?, 0, 1, NOW())",
          [masterUid, agentUid, m.email, defaultPassword, m.name || "Agent", m.phone || "", readableComment, isActive]
        );
      }
    }

    res.json({
      success: true,
      message: `Successfully synced ${members.length} CRM users under sstockology@gmail.com (${syncedActive} Active, ${syncedInactive} Inactive)!`,
      totalMembers: members.length,
      syncedActive,
      syncedInactive,
    });
  } catch (err) {
    console.error("Error in sync-crm-users:", err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (rootPool) {
      try { await rootPool.end(); } catch (_) {}
    }
  }
});

module.exports = router;
