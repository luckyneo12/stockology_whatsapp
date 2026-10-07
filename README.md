# Stockology WhatsApp & Multichannel Automation Engine

A high-performance WhatsApp CRM, AI Chatbot, and Multichannel messaging microservice for **Stockology Dashboard**.

## Features Included
- **WhatsApp Cloud API**: Official Meta Cloud API integration with Embedded Signup.
- **WhatsApp QR Login**: Baileys multi-device engine with MySQL session persistence.
- **AI Chatbot & Flow Builder**: Visual drag-and-drop flow builder with OpenAI GPT & Gemini AI integration.
- **Broadcast Campaigns**: Scheduled bulk broadcast delivery with rate-limiting & analytics.
- **AI Calling Automation**: OpenAI + ElevenLabs voice automated calling.
- **Telegram & Multi-channel**: Unified inbox for Telegram and WhatsApp.
- **Webhooks**: Two-way event triggers with Stockology CRM.

---

## Prerequisites
- **Node.js**: v20+ (v22 recommended)
- **MySQL**: 8.0+ or MariaDB 10.11+
- **PM2**: Process manager for production deployment

---

## Quick Setup Guide

### 1. Database Setup
Create a dedicated database and import the initial schema:
```bash
mysql -u root -p -e "CREATE DATABASE stockology_whatscrm CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
mysql -u root -p stockology_whatscrm < database/import.sql
```

### 2. Environment Configuration
Copy `.env.example` to `.env` and fill in your database credentials:
```bash
cp .env.example .env
```

Example `.env`:
```env
PORT=8001
DBHOST=localhost
DBNAME=stockology_whatscrm
DBUSER=root
DBPASS=YourSecurePassword
DBPORT=3306
JWTKEY=YourSuperSecretKey2026#
FRONTENDURI=https://crm.stockologysecurities.com,http://localhost:3001
BACKURI=https://uatcrm.stockologysecurities.com,http://localhost:4000
NODE_ENV=logs
```

### 3. Install Dependencies
```bash
npm install
```

### 4. Start Server
For development:
```bash
npm start
```

For production with PM2:
```bash
pm2 start server.js --name "stockology-whatsapp"
pm2 save
```

---

## Default Admin Credentials (Initial Setup)
- **URL**: `http://your-domain:8001/admin`
- **Email**: `admin@admin.com`
- **Password**: `Password@123`
*(Make sure to change the default password immediately after login)*

---

## Stockology CRM Integration
This microservice communicates with Stockology CRM via REST APIs and Webhooks:
- **Send Message API**: `POST /api/v1/send-message?token={user_api_key}`
- **Webhook Events**: Configured in Admin Panel to post inbound messages to `https://uatcrm.stockologysecurities.com/api/whatsapp/webhook`.
