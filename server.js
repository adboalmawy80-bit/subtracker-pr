import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import mysql from 'mysql2/promise';
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// 1. الاتصال بقاعدة بيانات MySQL السحابية
// ==========================================
let db;

async function initDB() {
    if (db) return db;
    try {
        db = await mysql.createConnection({
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME,
            port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
            ssl: {
                rejectUnauthorized: false
            }
        });

        console.log('✅ Remote MySQL Connected');

        const createTableQuery = `
            CREATE TABLE IF NOT EXISTS subscriptions (
                id INT AUTO_INCREMENT PRIMARY KEY,
                title VARCHAR(255) NOT NULL,
                category VARCHAR(100) DEFAULT 'General',
                amount DECIMAL(10, 2) NOT NULL,
                currency VARCHAR(10) DEFAULT 'USD',
                billingCycle VARCHAR(20) DEFAULT 'monthly',
                nextPaymentDate VARCHAR(50) NOT NULL,
                userEmail VARCHAR(255),
                status VARCHAR(20) DEFAULT 'active',
                notified BOOLEAN DEFAULT FALSE,
                createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `;
        await db.query(createTableQuery);
        return db;
    } catch (error) {
        console.error('❌ MySQL Connection Error:', error.message);
        throw error;
    }
}

// ==========================================
// 2. إعداد البريد الإلكتروني (Nodemailer)
// ==========================================
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

function sanitizeInput(str) {
    if (!str) return '';
    return String(str).replace(/[&<>'"]/g, 
        tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
    );
}

// ==========================================
// 3. Middlewares
// ==========================================
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '10kb' }));

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 150 });
app.use('/api/', limiter);
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// 4. API Routes
// ==========================================

// GET: جلب البيانات
app.get('/api/subscriptions', async (req, res) => {
    try {
        const connection = await initDB();
        const [rows] = await connection.query('SELECT * FROM subscriptions ORDER BY id DESC');
        res.json({ success: true, data: rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST: إضافة اشتراك
app.post('/api/subscriptions', async (req, res) => {
    try {
        const connection = await initDB();
        const { title, category, amount, currency, billingCycle, nextPaymentDate, userEmail } = req.body;

        if (!title || typeof title !== 'string' || !title.trim()) {
            return res.status(400).json({ success: false, error: 'Title is required' });
        }
        const parsedAmount = parseFloat(amount);
        if (isNaN(parsedAmount) || parsedAmount <= 0) {
            return res.status(400).json({ success: false, error: 'Valid positive amount required' });
        }
        if (!nextPaymentDate) {
            return res.status(400).json({ success: false, error: 'Payment date is required' });
        }

        let cleanEmail = '';
        if (userEmail && typeof userEmail === 'string' && userEmail.trim() !== '') {
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!emailRegex.test(userEmail.trim())) {
                return res.status(400).json({ success: false, error: 'Invalid email format' });
            }
            cleanEmail = userEmail.trim().toLowerCase();
        }

        const insertQuery = `
            INSERT INTO subscriptions (title, category, amount, currency, billingCycle, nextPaymentDate, userEmail, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
        `;

        const [result] = await connection.query(insertQuery, [
            sanitizeInput(title.trim()),
            category ? sanitizeInput(category.trim()) : 'General',
            Number(parsedAmount.toFixed(2)),
            currency || 'USD',
            billingCycle === 'yearly' ? 'yearly' : 'monthly',
            nextPaymentDate,
            cleanEmail
        ]);

        res.status(201).json({
            success: true,
            data: { id: result.insertId, title, category, amount, nextPaymentDate, userEmail: cleanEmail }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// DELETE: حذف اشتراك
app.delete('/api/subscriptions/:id', async (req, res) => {
    try {
        const connection = await initDB();
        const [result] = await connection.query('DELETE FROM subscriptions WHERE id = ?', [req.params.id]);
        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, error: 'Subscription not found' });
        }
        res.json({ success: true, message: 'Deleted successfully' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET: Cron Job لإرسال الإيميلات
app.get('/api/cron/send-reminders', async (req, res) => {
    try {
        const cronSecret = req.headers['x-cron-secret'] || req.query.secret;
        if (process.env.CRON_SECRET && cronSecret !== process.env.CRON_SECRET) {
            return res.status(401).json({ success: false, error: 'Unauthorized request' });
        }

        const connection = await initDB();
        const [subs] = await connection.query("SELECT * FROM subscriptions WHERE status = 'active' AND notified = FALSE AND userEmail != ''");

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        let sentCount = 0;

        for (const sub of subs) {
            const dueDate = new Date(sub.nextPaymentDate);
            dueDate.setHours(0, 0, 0, 0);

            const diffDays = Math.round((dueDate - today) / (1000 * 60 * 60 * 24));

            if (diffDays >= 0 && diffDays <= 3) {
                if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
                    await transporter.sendMail({
                        from: `"SubTracker Pro" <${process.env.EMAIL_USER}>`,
                        to: sub.userEmail,
                        subject: `⏰ Renewal Alert: ${sub.title}`,
                        html: `
                            <div style="font-family: sans-serif; padding: 20px; background: #0f172a; color: #f8fafc; border-radius: 10px;">
                                <h2 style="color: #fbbf24;">Subscription Renewal Alert</h2>
                                <p>Your subscription for <strong>${sub.title}</strong> is set to renew on <strong>${sub.nextPaymentDate}</strong>.</p>
                                <p>Amount: <strong>$${sub.amount}</strong></p>
                            </div>
                        `
                    });

                    await connection.query('UPDATE subscriptions SET notified = TRUE WHERE id = ?', [sub.id]);
                    sentCount++;
                }
            }
        }

        res.json({ success: true, message: `Notifications sent: ${sentCount}` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
}

export default app;