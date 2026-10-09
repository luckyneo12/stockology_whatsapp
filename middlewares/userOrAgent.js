const jwt = require("jsonwebtoken");
const { query } = require("../database/dbpromise");
const logger = require("../utils/logger");

const validateUserOrAgent = async (req, res, next) => {
  try {
    const authHeader = req.get("Authorization");

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        msg: "No token found",
      });
    }

    const token = authHeader.split(" ")[1];
    let decode;

    try {
      decode = jwt.verify(token, process.env.JWTKEY);
    } catch (err) {
      return res.status(401).json({
        success: false,
        msg: "Invalid token found",
      });
    }

    if (!decode?.uid) {
      return res.status(401).json({
        success: false,
        msg: "Unauthorized token",
      });
    }

    // ── 1. If agent token ─────────────────────────────────────────────
    if (decode.role === "agent") {
      const [agent] = await query(
        `SELECT * FROM agents WHERE uid = ? AND owner_uid = ?`,
        [decode.uid, decode.owner_uid]
      );

      if (!agent) {
        return res.status(401).json({
          success: false,
          msg: "Invalid agent token",
        });
      }

      if (agent.is_active < 1) {
        return res.status(403).json({
          success: false,
          msg: "You are an inactive agent.",
        });
      }

      const [owner] = await query(`SELECT * FROM user WHERE uid = ?`, [
        agent.owner_uid,
      ]);

      if (!owner) {
        return res.status(401).json({
          success: false,
          msg: "Agent owner not found",
        });
      }

      req.owner = owner;
      req.agent = agent;
      req.decode = {
        uid: agent.uid,
        role: "agent",
        email: agent.email,
        owner_uid: agent.owner_uid,
        tokenVersion: agent.tokenVersion || 0,
        userData: agent,
        crmUserId: decode.crmUserId,
        dataScope: decode.dataScope,
        departmentId: decode.departmentId,
        teamId: decode.teamId,
        scopedUserIds: decode.scopedUserIds,
      };

      return next();
    }

    // ── 2. If user token ──────────────────────────────────────────────
    if (decode.role === "user") {
      const getUser = await query(
        `SELECT * FROM user WHERE uid = ? AND role = ?`,
        [decode.uid, "user"]
      );

      if (getUser.length < 1) {
        return res.status(401).json({
          success: false,
          msg: "Invalid token found",
        });
      }

      req.decode = {
        uid: getUser[0].uid,
        role: "user",
        email: getUser[0].email,
        tokenVersion: getUser[0].tokenVersion || 0,
        userData: getUser[0],
        crmUserId: decode.crmUserId,
        dataScope: decode.dataScope,
        departmentId: decode.departmentId,
        teamId: decode.teamId,
        scopedUserIds: decode.scopedUserIds,
      };

      return next();
    }

    // ── 3. If admin token ─────────────────────────────────────────────
    if (decode.role === "admin") {
      const [admin] = await query(`SELECT * FROM admin WHERE uid = ?`, [
        decode.uid,
      ]);

      if (!admin) {
        return res.status(401).json({
          success: false,
          msg: "Admin not found",
        });
      }

      req.decode = {
        uid: admin.uid,
        role: "admin",
        email: admin.email,
        dataScope: "COMPANY",
      };

      return next();
    }

    return res.status(401).json({
      success: false,
      msg: "Unauthorized role",
    });
  } catch (err) {
    logger.error("validateUserOrAgent error:", err);
    return res.status(500).json({
      success: false,
      msg: "Server error",
    });
  }
};

module.exports = validateUserOrAgent;
