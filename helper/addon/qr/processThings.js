const randomstring = require("randomstring");
const moment = require("moment");
const { query } = require("../../../database/dbpromise");
const mime = require("mime-types");
const { fetchProfileUrl } = require("./control");
const fs = require("fs");

// Import downloadMediaMessage directly from baileys
let downloadMediaMessage;

// Function to load baileys dynamically
async function loadBaileys() {
  if (!downloadMediaMessage) {
    const baileys = await import("baileys");
    downloadMediaMessage = baileys.downloadMediaMessage;
  }
}

function timeoutPromise(promise, ms) {
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), ms));
  return Promise.race([promise, timeout]);
}

function extractPhoneNumber(str) {
  if (!str) return null;
  const match = str.match(/^(\d+)(?=:|\@)/);
  return match ? match[1] : null;
}

async function updateProfileMysql({
  chatId,
  uid,
  getSession,
  remoteJid,
  sessionId,
}) {
  try {
    if (remoteJid.includes("@g.us")) return;

    const session = await timeoutPromise(getSession(sessionId || "a"), 60000);
    if (!session) return;

    const image = await fetchProfileUrl(session, remoteJid);
    if (!image) return;

    // Get existing chat data to preserve other fields
    const [chat] = await query(
      `SELECT * FROM beta_chats WHERE uid = ? AND chat_id = ?`,
      [uid, chatId]
    );

    if (chat) {
      const profile = chat.profile_image
        ? { ...JSON.parse(chat.profile_image), profileImage: image }
        : { profileImage: image };
      await query(
        `UPDATE beta_chats SET last_message = JSON_SET(COALESCE(last_message, '{}'), '$.profileImage', ?), profile = ? WHERE uid = ? AND chat_id = ?`,
        [image, JSON.stringify(profile), uid, chatId]
      );
    }
  } catch (err) {
    console.log("Error updating profile data:", err);
  }
}

// Resolve responsible agent or device owner based on CRM Lead ownership and device allocation
async function resolveResponsibleAgentForChat({ senderMobile, sessionId, uid }) {
  try {
    if (!senderMobile || senderMobile === "NA") return null;

    // 1. Clean phone number: take last 10 digits
    const digitsOnly = String(senderMobile).replace(/\D/g, "");
    const last10Digits = digitsOnly.length >= 10 ? digitsOnly.slice(-10) : digitsOnly;
    if (!last10Digits || last10Digits.length < 7) return null;

    const crmDb = process.env.CRM_DB_NAME || "stockology_db_backup";

    // 2. Lookup device instance allocation
    const instances = await query(
      "SELECT id, uid, title, number, uniqueId, other FROM instance WHERE uniqueId = ? OR id = ? LIMIT 1",
      [sessionId, sessionId]
    );

    let meta = {};
    if (instances && instances.length > 0) {
      try {
        meta = typeof instances[0].other === "string" ? JSON.parse(instances[0].other) : instances[0].other || {};
      } catch (_) {}
    }

    // 3. Lookup CRM lead by phone number
    const leads = await query(
      "SELECT id, name, phone, assignedTo, departmentId FROM " + crmDb + ".crm_leads WHERE phone LIKE ? ORDER BY updatedAt DESC LIMIT 1",
      ["%" + last10Digits + "%"]
    );

    const lead = leads && leads.length > 0 ? leads[0] : null;

    // 4. Scenario A: Lead is assigned in CRM to a specific sales executive/member
    if (lead?.assignedTo) {
      const matchedAgents = await query(
        "SELECT id, uid, name, email, comments FROM agents WHERE comments LIKE ? LIMIT 1",
        ['%"crmUserId":"' + lead.assignedTo + '"%']
      );

      const ag = matchedAgents && matchedAgents.length > 0 ? matchedAgents[0] : null;
      let agComments = {};
      try {
        agComments = typeof ag?.comments === "string" ? JSON.parse(ag.comments) : ag?.comments || {};
      } catch (_) {}

      // Assigned strictly to the responsible sales executive
      return JSON.stringify([
        {
          id: ag?.id || null,
          uid: ag?.uid || null,
          name: ag?.name || lead.name,
          email: ag?.email || null,
          crmUserId: lead.assignedTo,
          leadId: lead.id,
          leadName: lead.name,
          teamId: meta.teamId || agComments.teamId || null,
          teamName: meta.teamName || agComments.teamName || null,
          departmentId: meta.departmentId || agComments.departmentId || null,
          departmentName: meta.departmentName || agComments.departmentName || null,
          dataScope: "SELF",
          deviceTitle: instances[0]?.title || null,
          deviceNumber: instances[0]?.number || null,
        },
      ]);
    }

    // 5. Scenario B: Lead NOT assigned to any team member (or unknown number)
    // Only the person who assigned the device (Team Leader / Dept Head / Manager) can see it!
    if (instances && instances.length > 0) {
      return JSON.stringify([
        {
          unassigned: true,
          teamId: meta.teamId || null,
          teamName: meta.teamName || null,
          teamLeader: meta.teamLeader || null,
          departmentId: meta.departmentId || null,
          departmentName: meta.departmentName || null,
          departmentHead: meta.departmentHead || null,
          deviceAssignedToUser: meta.assignedUserId || null,
          deviceTitle: instances[0]?.title || null,
          deviceNumber: instances[0]?.number || null,
        },
      ]);
    }

    return null;
  } catch (err) {
    console.error("resolveResponsibleAgentForChat error:", err);
    return null;
  }
}

async function updateChatInMysql({
  chatId,
  uid,
  senderName,
  senderMobile,
  actualMsg,
  sessionId,
  getSession,
  jid,
  user,
}) {
  try {
    const allowedMessageTypes = ["text", "image", "document", "video", "audio"];
    const isIncoming = actualMsg?.route === "INCOMING";

    // 🔥 Run profile update in background (don't wait for it)
    setImmediate(() => {
      updateProfileMysql({
        chatId,
        uid,
        getSession,
        remoteJid: jid,
        sessionId,
      });
    });

    const sessionData = await getSession(sessionId);
    let rawOriginInstance = sessionData?.authState?.creds?.me || sessionData?.user;

    // Fetch device instance to ensure number and uniqueId are always preserved
    let deviceInst = null;
    try {
      const instRows = await query(
        "SELECT id, uid, title, number, uniqueId, other FROM instance WHERE uniqueId = ? OR id = ? LIMIT 1",
        [sessionId, sessionId]
      );
      if (instRows && instRows.length > 0) deviceInst = instRows[0];
    } catch (_) {}

    const originInstanceId = {
      ...(typeof rawOriginInstance === "object" && rawOriginInstance !== null ? rawOriginInstance : { id: rawOriginInstance || sessionId }),
      uniqueId: sessionId,
      number: deviceInst?.number || null,
      title: deviceInst?.title || null,
    };

    // Check if chat exists
    const [chat] = await query(
      `SELECT unread_count, assigned_agent FROM beta_chats WHERE chat_id = ? AND uid = ? LIMIT 1`,
      [chatId, uid]
    );

    // Resolve responsible agent from CRM lead or Team Head
    let responsibleAgent = null;
    try {
      responsibleAgent = await resolveResponsibleAgentForChat({
        senderMobile,
        sessionId,
        uid,
      });
    } catch (e) {
      console.warn("Could not resolve responsible agent:", e.message);
    }

    const last_message = JSON.stringify(actualMsg);
    
    // Normalize mobile to ensure country code 91 is included for 10-digit Indian numbers
    let sender_mobile = senderMobile || "NA";
    if (sender_mobile !== "NA") {
      const digits = String(sender_mobile).replace(/\D/g, "");
      if (digits.length === 10) {
        sender_mobile = "91" + digits;
      } else if (digits.length > 10) {
        sender_mobile = digits;
      }
    }

    let sender_name = senderName || "NA";
    // Check if CRM lead has a real name
    try {
      const crmDb = process.env.CRM_DB_NAME || "stockology_db_backup";
      const digits = String(sender_mobile).replace(/\D/g, "");
      const last10 = digits.length >= 10 ? digits.slice(-10) : digits;
      if (last10 && last10.length >= 7) {
        const [crmLead] = await query(
          "SELECT name FROM " + crmDb + ".crm_leads WHERE phone LIKE ? ORDER BY updatedAt DESC LIMIT 1",
          ["%" + last10 + "%"]
        );
        if (crmLead?.name && crmLead.name !== "NA") {
          sender_name = crmLead.name;
        }
      }
    } catch (_) {}

    const origin = "qr";
    const origin_instance_id = JSON.stringify(originInstanceId);

    let unread_count = 0;
    if (isIncoming && allowedMessageTypes.includes(actualMsg?.type)) {
      unread_count = chat?.unread_count ? chat.unread_count + 1 : 1;
    }

    const msgEpoch = Number(actualMsg?.timestamp) || Math.round(Date.now() / 1000);
    const msgDate = moment.unix(msgEpoch).format("YYYY-MM-DD HH:mm:ss");

    if (chat) {
      const isCurrentlyUnassigned = !chat.assigned_agent || chat.assigned_agent === "null" || chat.assigned_agent === "[]" || chat.assigned_agent === "" || String(chat.assigned_agent).includes('"unassigned":true');
      const shouldUpdateAgent = Boolean(responsibleAgent && (isCurrentlyUnassigned || !String(responsibleAgent).includes('"unassigned":true')));
      await query(
        `UPDATE beta_chats 
         SET last_message = ?, 
             sender_name = ?, 
             sender_mobile = ?, 
             origin = ?, 
             origin_instance_id = ?,
             updatedAt = ?
             ${unread_count > 0 ? ", unread_count = ?" : ""}
             ${shouldUpdateAgent ? ", assigned_agent = ?" : ""}
         WHERE chat_id = ? AND uid = ?`,
        [
          last_message,
          sender_name,
          sender_mobile,
          origin,
          origin_instance_id,
          msgDate,
          ...(unread_count > 0 ? [unread_count] : []),
          ...(shouldUpdateAgent ? [responsibleAgent] : []),
          chatId,
          uid,
        ]
      );
    } else {
      await query(
        `INSERT INTO beta_chats 
         (uid, chat_id, last_message, sender_name, sender_mobile, origin, origin_instance_id, unread_count, assigned_agent, createdAt, updatedAt) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           last_message = VALUES(last_message),
           sender_name = IF(VALUES(sender_name) != 'NA', VALUES(sender_name), sender_name),
           origin_instance_id = VALUES(origin_instance_id),
           unread_count = unread_count + VALUES(unread_count),
           assigned_agent = IF(VALUES(assigned_agent) IS NOT NULL, VALUES(assigned_agent), assigned_agent),
           updatedAt = VALUES(updatedAt)`,
        [
          uid,
          chatId,
          last_message,
          sender_name,
          sender_mobile,
          origin,
          origin_instance_id,
          unread_count,
          responsibleAgent,
          msgDate,
          msgDate,
        ]
      );
    }
  } catch (err) {
    console.log("Error updating chat:", err);
  }
}

function getCurrentTimestampInTimeZone(timezone) {
  if (typeof timezone === "number") {
    return timezone;
  } else if (typeof timezone === "string") {
    const currentTimeInZone = moment.tz(timezone);
    return Math.round(currentTimeInZone.valueOf() / 1000);
  }
  return Math.round(Date.now() / 1000);
}

function saveImageToFile(imageBuffer, filePath, mimetype) {
  try {
    fs.writeFileSync(filePath, imageBuffer);
    console.log(`${mimetype || "IMG"} saved successfully as ${filePath}`);
  } catch (error) {
    console.error(`Error saving image: ${error.message}`);
  }
}

async function downloadMediaPromise(m, mimetype) {
  try {
    // Ensure baileys is loaded
    await loadBaileys();

    const bufferMsg = await downloadMediaMessage(m, "buffer", {}, {});
    const randomSt = randomstring.generate(6);
    const mimeType = mime.extension(mimetype);
    const fileName = `${randomSt}_qr.${mimeType}`;
    const filePath = `${__dirname}/../../../client/public/meta-media/${fileName}`;

    saveImageToFile(bufferMsg, filePath, mimetype);

    return { success: true, fileName };
  } catch (err) {
    console.log("Error in downloadMediaPromise:", err);
    return { err, success: false };
  }
}

function getChatId({ instanceNumber, senderMobile, uid }) {
  try {
    return `${instanceNumber}_${extractPhoneNumber(senderMobile)}_${uid}`;
  } catch (error) {
    return null;
  }
}

async function saveMessageToConversation({ uid, chatId, messageData }) {
  try {
    await query(
      `INSERT INTO beta_conversation 
       (type, metaChatId, msgContext, reaction, timestamp, senderName, senderMobile, star, route, context, origin, uid, chat_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         reaction = IF(VALUES(reaction) != "", VALUES(reaction), reaction),
         status = IF(VALUES(status) != "", VALUES(status), status)`,
      [
        messageData.type,
        messageData.metaChatId,
        JSON.stringify(messageData.msgContext),
        messageData.reaction || "",
        messageData.timestamp,
        messageData.senderName,
        messageData.senderMobile,
        messageData.star ? 1 : 0,
        messageData.route,
        messageData.context ? JSON.stringify(messageData.context) : null,
        messageData.origin,
        uid,
        chatId,
      ]
    );
    return true;
  } catch (err) {
    console.log("Error saving message to conversation:", err.message);
    return false;
  }
}

async function processBaileysMsg({ body, uid, userFromMysql, chatId }) {
  try {
    if (!body) return null;

    // Status Update Handling
    if (body.update && typeof body.update.status === "number") {
      if (!body.key?.fromMe) {
        return { newMessage: null, chatId };
      }

      const statusMapping = { 2: "sent", 3: "delivered", 4: "read" };
      const newStatusNumber = body.update.status;
      const newStatus = statusMapping[newStatusNumber] || "";

      await query(
        `UPDATE beta_conversation SET status = ? WHERE metaChatId = ? AND uid = ?`,
        [newStatus, body.key.id, uid]
      );

      return { newMessage: null, chatId };
    }

    let msgContext = null;
    let referencedMessageData = null;

    // console.log({ body: JSON.stringify(body) });

    // Determine message type
    if (body.message.conversation) {
      msgContext = {
        type: "text",
        text: {
          body: body.message.conversation,
          preview_url: true,
        },
      };
    } else if (body.message.reactionMessage) {
      const reaction = body.message.reactionMessage;

      // Find the original message that was reacted to
      const [originalMessage] = await query(
        `SELECT * FROM beta_conversation WHERE metaChatId = ? AND uid = ?`,
        [reaction.key.id, uid]
      );

      if (originalMessage) {
        // Update the reaction field in the original message
        await query(
          `UPDATE beta_conversation SET reaction = ? WHERE metaChatId = ? AND uid = ?`,
          [reaction.text, reaction.key.id, uid]
        );

        // Return null as we don't need to create a new message for reactions
        return { newMessage: null, chatId };
      }

      // If original message not found, log warning
      console.warn(
        `Original message ${reaction.key.id} not found for reaction`
      );
      return { newMessage: null, chatId };
    } else if (body.message.extendedTextMessage) {
      const extText = body.message.extendedTextMessage;
      msgContext = {
        type: "text",
        text: {
          body: extText.text,
          preview_url: true,
        },
      };
      if (extText.contextInfo?.quotedMessage) {
        referencedMessageData = extText.contextInfo.quotedMessage;
      }
    } else if (body.message.imageMessage) {
      const img = body.message.imageMessage;
      const downloadResult = await downloadMediaPromise(body, img.mimetype);
      msgContext = {
        type: "image",
        image: {
          link: `${process.env.FRONTENDURI}/meta-media/${
            downloadResult.success ? downloadResult.fileName : ""
          }`,
          caption: img.caption || "",
        },
      };
    } else if (body.message.videoMessage) {
      const vid = body.message.videoMessage;
      const downloadResult = await downloadMediaPromise(body, vid.mimetype);
      msgContext = {
        type: "video",
        video: {
          link: `${process.env.FRONTENDURI}/meta-media/${
            downloadResult.success ? downloadResult.fileName : ""
          }`,
          caption: vid.caption || "",
        },
      };
    } else if (body.message.contactMessage) {
      const contact = body.message.contactMessage;
      msgContext = {
        type: "contact",
        contact: {
          name: contact.displayName || "Unknown Contact",
          vcard: contact.vcard || "",
        },
      };
    } else if (body.message.audioMessage) {
      const aud = body.message.audioMessage;
      const downloadResult = await downloadMediaPromise(body, aud.mimetype);
      msgContext = {
        type: "audio",
        audio: {
          link: `${process.env.FRONTENDURI}/meta-media/${
            downloadResult.success ? downloadResult.fileName : ""
          }`,
        },
      };
    } else if (body.message.locationMessage) {
      msgContext = {
        type: "location",
        location: {
          latitude: body.message?.locationMessage?.degreesLatitude,
          longitude: body.message?.locationMessage?.degreesLongitude,
          name: body.message?.locationMessage?.name,
          address: body.message?.locationMessage?.address,
        },
      };
    } else if (body.message.documentWithCaptionMessage) {
      const doc =
        body.message.documentWithCaptionMessage.message.documentMessage;
      const downloadResult = await downloadMediaPromise(
        body,
        body?.message?.documentWithCaptionMessage?.message?.documentMessage?.mimetype?.replace(
          "application/x-javascript",
          "application/javascript"
        )
      );
      msgContext = {
        type: "document",
        document: {
          link: `${process.env.FRONTENDURI}/meta-media/${
            downloadResult.success ? downloadResult.fileName : ""
          }`,
          caption: doc.caption || doc.title || "",
        },
      };
      if (doc.contextInfo?.quotedMessage) {
        referencedMessageData = doc.contextInfo.quotedMessage;
      }
    } else if (body.message.documentMessage) {
      // Handle regular document messages without caption
      const doc = body.message.documentMessage;
      const downloadResult = await downloadMediaPromise(body, doc.mimetype);
      msgContext = {
        type: "document",
        document: {
          link: `${process.env.FRONTENDURI}/meta-media/${
            downloadResult.success ? downloadResult.fileName : ""
          }`,
          caption: doc.caption || doc.title || doc.fileName || "",
        },
      };
      if (doc.contextInfo?.quotedMessage) {
        referencedMessageData = doc.contextInfo.quotedMessage;
      }
    } else {
      console.warn("Unsupported message type in Baileys webhook");
      return null;
    }

    // Determine context from quoted message if available
    let contextData = "";
    if (referencedMessageData?.stanzaId) {
      const [foundMsg] = await query(
        `SELECT * FROM beta_conversation WHERE metaChatId = ? AND uid = ?`,
        [referencedMessageData.stanzaId, uid]
      );
      contextData = foundMsg || referencedMessageData;
    } else if (referencedMessageData) {
      contextData = referencedMessageData;
    }

    // Extract actual message timestamp from Baileys
    let rawTs = body.messageTimestamp;
    if (typeof rawTs === "object" && rawTs !== null && "low" in rawTs) {
      rawTs = rawTs.low;
    }
    const msgTimestamp = Number(rawTs) || Math.round(Date.now() / 1000);

    // Create the new message object
    const newMessage = {
      type: msgContext.type,
      metaChatId: body.key.id,
      msgContext,
      reaction: "",
      timestamp: msgTimestamp,
      senderName: body.pushName || "NA",
      senderMobile: body.key.remoteJid
        ? body.key.remoteJid.split("@")[0]
        : "NA",
      status: "",
      star: false,
      route: body.key?.fromMe ? "OUTGOING" : "INCOMING",
      context: contextData,
      origin: "qr",
    };

    // Save message to MySQL
    await saveMessageToConversation({
      uid,
      chatId,
      messageData: newMessage,
    });

    return { newMessage, chatId };
  } catch (err) {
    console.error("Error processing Baileys message:", err);
    return null;
  }
}

async function getUserDetails(sessionId, userData) {
  try {
    // Only get instance data, user data is already provided
    const [instance] = await query(
      `SELECT 
        id,
        uid,
        number,
        uniqueId,
        data,
        other
      FROM instance
      WHERE uniqueId = ?
      LIMIT 1`,
      [sessionId]
    );

    if (!instance) return null;

    // Combine userData with instance
    return {
      ...userData,
      instance: {
        id: instance.id,
        uid: instance.uid,
        number: instance.number,
        uniqueId: instance.uniqueId,
        data: instance.data,
        other: instance.other,
        status: instance.status,
      },
    };
  } catch (err) {
    console.error("getUserDetails error:", err);
    return null;
  }
}

async function processMessageQr({
  type,
  message,
  sessionId,
  getSession,
  userData,
  uid,
}) {
  try {
    const userDetails = await getUserDetails(sessionId, userData);

    if (!userDetails) {
      return;
    }

    const instanceNumber = userDetails?.instance?.number;

    if (!instanceNumber || !message.key.remoteJid || !uid) {
      console.log("Details not found to update chat list");
      console.log({
        instanceNumber,
        senderMobile: message.key.remoteJid,
        uid,
      });
    }

    const chatId = getChatId({
      instanceNumber,
      senderMobile: message.key.remoteJid,
      uid,
    });

    const data = await processBaileysMsg({
      body: message,
      uid: uid,
      userFromMysql: userData,
      chatId,
    });

    // Update chat in MySQL with the latest message
    if (data?.newMessage) {
      await updateChatInMysql({
        chatId,
        uid: uid,
        senderName: data.newMessage.senderName,
        senderMobile: data.newMessage.senderMobile,
        actualMsg: data.newMessage,
        sessionId,
        getSession,
        jid: message?.remoteJid || message?.key?.remoteJid,
        userPromise: userDetails,
        user: userData,
      });
    }

    return data;
  } catch (err) {
    console.error("processMessageQr error:", err);
    return null;
  }
}

module.exports = {
  processMessageQr,
};
