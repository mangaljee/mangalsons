const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// ==========================================
// 1. AUTHENTICATION (Login & Role)
// ==========================================
app.post('/api/auth/login', async (req, res) => {
    const { loginType, emp_code, pin } = req.body;
    try {
        if(loginType === 'Owner') {
            const admin = await pool.query('SELECT * FROM admin_auth WHERE pin = $1', [pin]);
            if(admin.rows.length > 0) return res.json({ success: true, role: 'Owner' });
        } else {
            const emp = await pool.query('SELECT role FROM employees WHERE emp_code = $1 AND pin = $2', [emp_code, pin]);
            if(emp.rows.length > 0) return res.json({ success: true, role: emp.rows[0].role });
        }
        res.status(401).json({ success: false, message: "Invalid Credentials" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==========================================
// 2. MASTER DASHBOARD SUMMARY
// ==========================================
app.get('/api/dashboard/summary', async (req, res) => {
    try {
        const today = new Date().toISOString().split('T')[0];
        const salesRes = await pool.query(`SELECT COALESCE(SUM(total_amount), 0) as today_sales, COALESCE(SUM(amount_paid), 0) as today_collection FROM invoices WHERE invoice_date::date = $1 AND is_deleted = false`, [today]);
        const udhaarRes = await pool.query('SELECT COALESCE(SUM(outstanding_balance), 0) as total_udhaar FROM customers');
        const pendingDel = await pool.query("SELECT COUNT(*) FROM deliveries WHERE status != 'Installed'");
        const pendingComplaints = await pool.query("SELECT COUNT(*) FROM complaints WHERE status = 'Pending'");
        
        res.json({
            success: true,
            data: {
                today_sales: salesRes.rows[0].today_sales,
                today_collection: salesRes.rows[0].today_collection,
                pending_udhaar: udhaarRes.rows[0].total_udhaar,
                alerts: { 
                    pending_deliveries: pendingDel.rows[0].count,
                    pending_complaints: pendingComplaints.rows[0].count 
                }
            }
        });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ==========================================
// 3. BILLING & PRODUCTS
// ==========================================
app.get('/api/products/search', async (req, res) => {
    const { query } = req.query;
    try {
        const result = await pool.query("SELECT product_id, product_name, base_price, stock_quantity FROM products WHERE product_name ILIKE $1", [`%${query}%`]);
        res.json({ success: true, data: result.rows });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/billing/create', async (req, res) => {
    const { customer_phone, customer_name, total_amount, amount_paid, discount_amount, payment_mode, items } = req.body;
    try {
        await pool.query('BEGIN');
        let custRes = await pool.query('SELECT customer_id FROM customers WHERE phone = $1', [customer_phone]);
        let custId;
        if (custRes.rows.length === 0) {
            const newCust = await pool.query('INSERT INTO customers (name, phone) VALUES ($1, $2) RETURNING customer_id', [customer_name, customer_phone]);
            custId = newCust.rows[0].customer_id;
        } else { custId = custRes.rows[0].customer_id; }

        const balance_due = total_amount - amount_paid;
        const invoice_no = `INV-${Date.now()}`;
        const invRes = await pool.query(
            'INSERT INTO invoices (customer_id, invoice_no, total_amount, amount_paid, balance_due, discount_amount, payment_mode) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING invoice_id',
            [custId, invoice_no, total_amount, amount_paid, balance_due, discount_amount, payment_mode]
        );
        
        if (balance_due > 0) await pool.query('UPDATE customers SET outstanding_balance = outstanding_balance + $1 WHERE customer_id = $2', [balance_due, custId]);

        for (let item of items) {
            await pool.query('INSERT INTO invoice_items (invoice_id, product_name, warranty_months) VALUES ($1, $2, $3)', [invRes.rows[0].invoice_id, item.product_name, 12]);
            await pool.query('UPDATE products SET stock_quantity = stock_quantity - $1 WHERE product_name = $2', [item.qty, item.product_name]);
        }
        await pool.query('COMMIT');
        res.json({ success: true, invoice_no });
    } catch (err) { await pool.query('ROLLBACK'); res.status(500).json({ error: err.message }); }
});

// ==========================================
// 4. HR, COMPLAINTS & SUPPLIER PAYMENTS
// ==========================================
app.post('/api/hr/attendance', async (req, res) => {
    const { emp_code, type } = req.body;
    try {
        if(type === 'IN') await pool.query('INSERT INTO attendance (emp_code, check_in) VALUES ($1, NOW())', [emp_code]);
        else await pool.query('UPDATE attendance SET check_out = NOW() WHERE emp_code = $1 AND check_out IS NULL', [emp_code]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/complaints/add', async (req, res) => {
    const { customer_id, item_id, description } = req.body;
    try {
        await pool.query('INSERT INTO complaints (customer_id, item_id, issue_description) VALUES ($1, $2, $3)', [customer_id, item_id, description]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/suppliers/pay', async (req, res) => {
    const { supplier_id, amount, remarks } = req.body;
    try {
        await pool.query('BEGIN');
        await pool.query('INSERT INTO supplier_payments (supplier_id, amount, remarks) VALUES ($1, $2, $3)', [supplier_id, amount, remarks]);
        await pool.query('UPDATE suppliers SET outstanding_balance = outstanding_balance - $1 WHERE supplier_id = $2', [amount, supplier_id]);
        await pool.query('COMMIT');
        res.json({ success: true });
    } catch (err) { await pool.query('ROLLBACK'); res.status(500).json({ error: err.message }); }
});

app.listen(port, () => console.log(`Master ERP Engine running on ${port}`));
