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

module.exports = router;
