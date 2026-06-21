const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

// Premium CORS integration for multiple device connectivity
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// 🔥 SIZE LIMIT EXPANSION: Base64 Images aur Heavy Billing payload crash rokne ke liye
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Database connection initialization using connection string
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// ==========================================
// MODULE 1: AUTHENTICATION ENGINE
// ==========================================
app.post('/api/admin/login', async (req, res) => {
    const { pin } = req.body;
    try {
        const result = await pool.query('SELECT * FROM admin_auth WHERE pin = $1', [pin]);
        if (result.rows.length > 0) res.json({ success: true, message: "Admin authenticated successfully" });
        else res.status(401).json({ success: false, message: "Invalid Admin PIN" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/change-pin', async (req, res) => {
    const { oldPin, newPin } = req.body;
    try {
        const check = await pool.query('SELECT * FROM admin_auth WHERE pin = $1', [oldPin]);
        if (check.rows.length > 0) {
            await pool.query('UPDATE admin_auth SET pin = $1 WHERE pin = $2', [newPin, oldPin]);
            res.json({ success: true, message: "Admin PIN updated successfully" });
        } else {
            res.status(400).json({ success: false, message: "Current PIN is incorrect" });
        }
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/employees/login', async (req, res) => {
    const { emp_code, pin } = req.body;
    try {
        const result = await pool.query('SELECT * FROM employees WHERE emp_code = $1 AND pin = $2', [emp_code, pin]);
        if (result.rows.length > 0) res.json({ success: true, data: result.rows[0] });
        else res.status(401).json({ success: false, message: "Invalid Employee Code or PIN" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/employees/add', async (req, res) => {
    const { emp_code, name, phone, pin } = req.body;
    try {
        await pool.query('INSERT INTO employees (emp_code, name, phone, pin) VALUES ($1, $2, $3, $4)', [emp_code, name, phone, pin]);
        res.json({ success: true, message: "Staff member registered successfully" });
    } catch (err) { res.status(400).json({ error: "Employee Code already exists configuration." }); }
});

// ==========================================
// MODULE 2: HACK-PROOF ATTENDANCE & REWARDS
// ==========================================
app.post('/api/attendance/punch', async (req, res) => {
    const { emp_code, lat, lon, punch_type, photo } = req.body;
    try {
        // 🔥 ANTI-SPOOFING HACK: Device time system ignore, direct cloud time tracking
        const serverTime = new Date();
        const currentHour = serverTime.getHours() + 5; // IST Calculation Buffer
        const currentMin = serverTime.getMinutes() + 30;

        const checkExisting = await pool.query('SELECT * FROM attendance WHERE emp_code = $1 AND attendance_date = CURRENT_DATE', [emp_code]);

        if (checkExisting.rows.length === 0) {
            await pool.query('INSERT INTO attendance (emp_code, punch_location_lat, punch_location_lon, photo) VALUES ($1, $2, $3, $4)', [emp_code, lat, lon, photo]);
            
            // Milestone Rewards: Early Bird criteria (Before 10:15 AM)
            if (currentHour < 10 || (currentHour === 10 && currentMin <= 15)) {
                await pool.query('UPDATE employees SET points = points + 10, current_streak = current_streak + 1 WHERE emp_code = $1', [emp_code]);
                return res.json({ success: true, message: "Morning Check-In Done! 🌟 Milestone Complete: +10 Points!" });
            } else {
                await pool.query('UPDATE employees SET current_streak = 0 WHERE emp_code = $1', [emp_code]);
                return res.json({ success: true, message: "Morning Check-In Done! You were late today." });
            }
        }

        const record = checkExisting.rows[0];
        if (punch_type === "LUNCH_OUT" && record.lunch_out_time === null) {
            await pool.query('UPDATE attendance SET lunch_out_time = CURRENT_TIMESTAMP WHERE id = $1', [record.id]);
            return res.json({ success: true, message: "Lunch Break logs started successfully" });
        }
        if (punch_type === "LUNCH_IN" && record.lunch_in_time === null && record.lunch_out_time !== null) {
            await pool.query('UPDATE attendance SET lunch_in_time = CURRENT_TIMESTAMP WHERE id = $1', [record.id]);
            return res.json({ success: true, message: "Welcome back from lunch break" });
        }
        if (punch_type === "CHECK_OUT" && record.check_out_time === null) {
            await pool.query('UPDATE attendance SET check_out_time = CURRENT_TIMESTAMP WHERE id = $1', [record.id]);
            return res.json({ success: true, message: "Evening Check-Out complete. Safe travels!" });
        }
        res.status(400).json({ success: false, message: "Action sequence invalid or already completed today." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Attendance tracking pipelines for Dashboards
app.get('/api/attendance/history', async (req, res) => {
    const { date } = req.query;
    try {
        const result = await pool.query(`
            SELECT e.name, e.emp_code, a.check_in_time, a.lunch_out_time, a.lunch_in_time, a.check_out_time, a.photo, a.punch_location_lat, a.punch_location_lon 
            FROM attendance a JOIN employees e ON a.emp_code = e.emp_code 
            WHERE a.attendance_date = $1 ORDER BY a.check_in_time DESC
        `, [date]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/employee/my-history/:emp_code', async (req, res) => {
    const { emp_code } = req.params;
    try {
        const result = await pool.query(`
            SELECT attendance_date, check_in_time, lunch_out_time, lunch_in_time, check_out_time 
            FROM attendance WHERE emp_code = $1 ORDER BY attendance_date DESC LIMIT 30
        `, [emp_code]);
        res.json({ success: true, data: result.rows });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==========================================
// MODULE 3: INVENTORY TRACKING (MAAL AANA)
// ==========================================
app.post('/api/inventory/add', async (req, res) => {
    const { product_name, category, base_price, gst_percent, serial_numbers, quantity } = req.body;
    try {
        await pool.query('BEGIN'); // Atomic Transaction Block Open

        let prodRes = await pool.query('SELECT product_id FROM products WHERE product_name = $1', [product_name]);
        let prodId;

        if (prodRes.rows.length === 0) {
            const insertProd = await pool.query(
                'INSERT INTO products (product_name, category, base_price, gst_percent, stock_quantity) VALUES ($1, $2, $3, $4, $5) RETURNING product_id',
                [product_name, category, base_price, gst_percent, category === 'Furniture' ? quantity : 0]
            );
            prodId = insertProd.rows[0].product_id;
        } else {
            prodId = prodRes.rows[0].product_id;
            if (category === 'Furniture') {
                await pool.query('UPDATE products SET stock_quantity = stock_quantity + $1 WHERE product_id = $2', [quantity, prodId]);
            }
        }

        // Electronics unique Serial Number entry tracking pipelines
        if (category === 'Electronics' && serial_numbers && serial_numbers.length > 0) {
            for (let sn of serial_numbers) {
                await pool.query('INSERT INTO product_serials (product_id, serial_number) VALUES ($1, $2) ON CONFLICT DO NOTHING', [prodId, sn]);
            }
            await pool.query('UPDATE products SET stock_quantity = stock_quantity + $1 WHERE product_id = $2', [serial_numbers.length, prodId]);
        }

        await pool.query('COMMIT');
        res.json({ success: true, message: "Inventory Stock updated smoothly!" });
    } catch (err) {
        await pool.query('ROLLBACK');
        res.status(500).json({ success: false, error: err.message });
    }
});

// ==========================================
// MODULE 4: BILLING ENGINE & KHATA (MAAL JAANA)
// ==========================================
app.post('/api/billing/create', async (req, res) => {
    const { customer_phone, customer_name, is_gst_bill, total_amount, amount_paid, items } = req.body;
    try {
        await pool.query('BEGIN');

        let custRes = await pool.query('SELECT customer_id FROM customers WHERE phone = $1', [customer_phone]);
        let custId;
        if (custRes.rows.length === 0) {
            const newCust = await pool.query('INSERT INTO customers (name, phone) VALUES ($1, $2) RETURNING customer_id', [customer_name, customer_phone]);
            custId = newCust.rows[0].customer_id;
        } else {
            custId = custRes.rows[0].customer_id;
        }

        const balance_due = total_amount - amount_paid;
        const invoice_no = `INV-${Date.now()}`;

        const invRes = await pool.query(
            'INSERT INTO invoices (customer_id, invoice_no, total_amount, amount_paid, balance_due, is_gst_bill) VALUES ($1, $2, $3, $4, $5, $6) RETURNING invoice_id',
            [custId, invoice_no, total_amount, amount_paid, balance_due, is_gst_bill]
        );
        const invoiceId = invRes.rows[0].invoice_id;

        // 🔥 AUTOMATIC KHATA BOOK TRACKING: Udhaar calculation automatic profile update
        if (balance_due > 0) {
            await pool.query('UPDATE customers SET outstanding_balance = outstanding_balance + $1 WHERE customer_id = $2', [balance_due, custId]);
        }

        for (let item of items) {
            await pool.query(
                'INSERT INTO invoice_items (invoice_id, product_name, serial_number, warranty_months) VALUES ($1, $2, $3, $4)',
                [invoiceId, item.product_name, item.serial_number, item.warranty_months]
            );

            if (item.serial_number) {
                await pool.query('UPDATE product_serials SET status = $1, sold_invoice_id = $2 WHERE serial_number = $3', ['SOLD', invoiceId, item.serial_number]);
            }
            await pool.query('UPDATE products SET stock_quantity = stock_quantity - 1 WHERE product_name = $1', [item.product_name]);
        }

        await pool.query('COMMIT');
        res.json({ success: true, message: "Invoice generated and Khata updated!", invoice_no: invoice_no });
    } catch (err) {
        await pool.query('ROLLBACK');
        res.status(500).json({ success: false, error: err.message });
    }
});

// ==========================================
// MODULE 5: CRM SEARCH, WARRANTY & COMPLAINTS
// ==========================================
app.get('/api/customer/search', async (req, res) => {
    const { phone } = req.query;
    try {
        const customerResult = await pool.query('SELECT * FROM customers WHERE phone = $1', [phone]);
        if (customerResult.rows.length === 0) return res.json({ success: false, message: "Customer account not registered yet." });

        const customer = customerResult.rows[0];

        // 🔥 SMART WARRANTY CHECKER: Live Postgres interval verification logic built-in
        const itemsResult = await pool.query(`
            SELECT ii.item_id, ii.product_name, ii.serial_number, ii.purchase_date, ii.warranty_months, inv.invoice_no,
            CASE 
                WHEN (ii.purchase_date + (ii.warranty_months || ' months')::interval) >= CURRENT_DATE THEN 'IN_WARRANTY' 
                ELSE 'OUT_OF_WARRANTY' 
            END as warranty_status
            FROM invoice_items ii 
            JOIN invoices inv ON ii.invoice_id = inv.invoice_id
            WHERE inv.customer_id = $1 ORDER BY ii.purchase_date DESC
        `, [customer.customer_id]);

        res.json({ success: true, customer: customer, items: itemsResult.rows });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/complaints/add', async (req, res) => {
    const { customer_id, item_id, issue_description } = req.body;
    try {
        await pool.query('INSERT INTO complaints (customer_id, item_id, issue_description) VALUES ($1, $2, $3)', [customer_id, item_id, issue_description]);
        res.json({ success: true, message: "Service Complaint Registered Successfully!" });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.listen(port, () => console.log(`Unified Master ERP Service running smoothly on port ${port}`));
