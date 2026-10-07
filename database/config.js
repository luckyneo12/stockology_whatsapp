const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });
const mysql = require("mysql2");

const DBHOST = process.env.DBHOST || "127.0.0.1";
const DBPORT = Number(process.env.DBPORT) || 3306;
const DBUSER = process.env.DBUSER || "root";
const DBPASS = process.env.DBPASS !== undefined ? process.env.DBPASS : "Admin@123456";
const DBNAME = process.env.DBNAME || "stockology_whatscrm";

console.log(`[DB INFO] Connecting to MySQL => Host: ${DBHOST}:${DBPORT}, DB: ${DBNAME}, User: ${DBUSER}, Has Password: ${Boolean(DBPASS)}`);

const con = mysql.createPool({
  connectionLimit: 200,
  host: DBHOST,
  port: DBPORT,
  user: DBUSER,
  password: DBPASS,
  database: DBNAME,
  charset: "utf8mb4",
  waitForConnections: true,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
});

// Handle connection errors
con.on("connection", function (connection) {
  // console.log("Database connection established as id " + connection.threadId);
});

con.on("error", function (err) {
  console.error("Database error:", err);
  if (err.code === "PROTOCOL_CONNECTION_LOST") {
    console.log("Database connection lost, reconnecting...");
  }
});

con.getConnection((err, connection) => {
  if (err) {
    console.log({
      err: err,
      msg: "Database connected error",
    });
    return;
  } else {
    console.log("Database has been connected");
    connection.release();
  }
});

module.exports = con;
