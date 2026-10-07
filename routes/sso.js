const router = require("express").Router();
const { query } = require("../database/dbpromise.js");
const randomstring = require("randomstring");
const bcrypt = require("bcrypt");
const { sign } = require("jsonwebtoken");

// POST /api/sso/auth
router.post("/auth", async (req, res) => {
  try {
    const { email, name, role, secret, parentEmail } = req.body;

    const expectedSecret = process.env.SSO_SECRET || process.env.JWTKEY;
    if (!secret || secret !== expectedSecret) {
      return res.status(401).json({ success: false, msg: "Unauthorized SSO request" });
    }

    if (!email) {
      return res.status(400).json({ success: false, msg: "Email is required" });
    }

    const targetRole = role === "admin" ? "admin" : role === "agent" ? "agent" : "user";

    // ── Admin SSO ─────────────────────────────────────────────────────────────
    if (targetRole === "admin") {
      let admins = await query(`SELECT * FROM admin WHERE email = ?`, [email]);
      if (admins.length === 0) {
        // Fallback to first admin
        admins = await query(`SELECT * FROM admin LIMIT 1`, []);
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

    // ── Agent (Sales / Telecaller) SSO ───────────────────────────────────────
    if (targetRole === "agent") {
      // Find or determine owner_uid (Team Leader / Parent)
      let ownerUid = null;
      if (parentEmail) {
        const parentUser = await query(`SELECT uid FROM user WHERE email = ?`, [parentEmail]);
        if (parentUser.length > 0) ownerUid = parentUser[0].uid;
      }
      if (!ownerUid) {
        // Fallback to first user as owner
        const firstUser = await query(`SELECT uid FROM user LIMIT 1`, []);
        if (firstUser.length > 0) ownerUid = firstUser[0].uid;
      }

      let agents = await query(`SELECT * FROM agents WHERE email = ?`, [email]);
      let agent;
      if (agents.length === 0) {
        const agentUid = randomstring.generate(32);
        const pass = await bcrypt.hash(randomstring.generate(16), 10);
        await query(
          `INSERT INTO agents (owner_uid, uid, name, email, password, role, is_active, allow_send, mask, createdAt) VALUES (?, ?, ?, ?, ?, 'agent', 1, 1, 0, NOW())`,
          [ownerUid, agentUid, name || "Agent", email, pass]
        );
        const created = await query(`SELECT * FROM agents WHERE uid = ?`, [agentUid]);
        agent = created[0];
      } else {
        agent = agents[0];
        // Ensure owner_uid is set if parentEmail was provided
        if (ownerUid && agent.owner_uid !== ownerUid) {
          await query(`UPDATE agents SET owner_uid = ? WHERE uid = ?`, [ownerUid, agent.uid]);
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

      return res.json({ success: true, token, role: "agent", uid: agent.uid, owner_uid: agent.owner_uid, redirect: "/agent" });
    }

    // ── User (Team Leader / Department Manager) SSO ─────────────────────────
    let users = await query(`SELECT * FROM user WHERE email = ?`, [email]);
    let user;
    if (users.length === 0) {
      const uid = randomstring.generate(32);
      const defaultPassword = await bcrypt.hash(randomstring.generate(16), 10);
      
      const plans = await query(`SELECT * FROM plan ORDER BY id DESC LIMIT 1`, []);
      const planObj = plans.length > 0 ? plans[0].plan : JSON.stringify({
        title: "CRM Business Plan",
        allow_tag: 1,
        allow_note: 1,
        allow_chatbot: 1,
        contact_limit: "50000",
        allow_api: 1,
        qr_account: 10,
        wa_warmer: 1,
        rest_api_qr: 1,
        allow_wa_forms: 1
      });

      await query(
        `INSERT INTO user (role, uid, name, email, password, plan, active_plan, createdAt) VALUES (?, ?, ?, ?, ?, ?, 1, NOW())`,
        ["user", uid, name || "Team Leader", email, defaultPassword, typeof planObj === "object" ? JSON.stringify(planObj) : planObj]
      );

      const created = await query(`SELECT * FROM user WHERE uid = ?`, [uid]);
      user = created[0];
    } else {
      user = users[0];
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
