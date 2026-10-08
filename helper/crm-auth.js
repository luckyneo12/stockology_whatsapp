const axios = require("axios");

async function verifyWithCrm(email, password) {
  if (!email || !password) return null;

  const candidateUrls = [
    process.env.CRM_API_URL ? `${process.env.CRM_API_URL.replace(/\/+$/, "")}/api/auth/login` : null,
    "http://127.0.0.1:4000/api/auth/login",
    "http://127.0.0.1:3000/api/auth/login",
    "http://127.0.0.1:5000/api/auth/login",
    "http://localhost:4000/api/auth/login",
    "http://localhost:3000/api/auth/login",
    "https://crm.stockologysecurities.com/api/auth/login",
  ].filter(Boolean);

  for (const url of candidateUrls) {
    try {
      const response = await axios.post(
        url,
        { email: email.trim().toLowerCase(), password },
        { timeout: 3500 }
      );
      if (response.data?.success && response.data?.user) {
        return response.data.user;
      }
    } catch (err) {
      // Continue to next URL candidate
    }
  }

  return null;
}

module.exports = { verifyWithCrm };
