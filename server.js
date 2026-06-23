const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

// Middleware Setup
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));

// Database Connection (Neon PostgreSQL)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// ==========================================
// 1. AUTHENTICATION (Owner & Staff)
// ==========================================
app.post('/api/auth/login', async (req, res) => {
    const { loginType, emp_code, pin } = req.body;
    try {
        if(loginType === 'Owner') {
            const admin = await pool.query('SELECT * FROM admin_auth WHERE pin = $1', [pin]);
            if(admin.rows.length > 0) return res.json({ success: true, role: 'Owner' });
        } else {
            const emp = await pool.query('SELECT role, access_rights FROM employees WHERE emp_code = $1 AND pin = $2', [emp_code, pin]);
            if(emp.rows.length > 0) return res.json({ success: true, role: emp.rows[0].role, access: emp.rows[0].access_rights });
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
        const salesRes = await pool.query(`SELECT COALESCE(SUM(total_amount), 0) as today_sales FROM invoices WHERE invoice_date::date = $1 AND is_deleted = false`, [today]);
        const udhaarRes = await pool.query('SELECT COALESCE(SUM(outstanding_balance), 0) as total_udhaar FROM customers');
        const pendingDel = await pool.query("SELECT COUNT(*) FROM deliveries WHERE status != 'Installed'");
        const pendingComplaints = await pool.query("SELECT COUNT(*) FROM complaints WHERE status = 'Pending'");
        
        res.json({
            success: true,
            data: {
                today_sales: salesRes.rows[0].today_sales,
                pending_udhaar: udhaarRes.rows[0].total_udhaar,
                alerts: { pending_deliveries: pendingDel.rows[0].count, pending_complaints: pendingComplaints.rows[0].count }
            }
        });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ==========================================
// 3. BILLING, POS & INVENTORY SYNC
// ==========================================
app.post('/api/billing/create', async (req, res) => {
    const { customer_phone, customer_name, total_amount, amount_paid, payment_mode, items, is_gst } = req.body;
    try {
        await pool.query('BEGIN'); // Start Transaction

        // 1. Manage Customer
        let custRes = await pool.query('SELECT customer_id FROM customers WHERE phone = $1', [customer_phone]);
        let custId;
        if (custRes.rows.length === 0) {
            const newCust = await pool.query('INSERT INTO customers (name, phone) VALUES ($1, $2) RETURNING customer_id', [customer_name, customer_phone]);
            custId = newCust.rows[0].customer_id;
        } else { custId = custRes.rows[0].customer_id; }

        // 2. Generate Invoice
        const balance_due = total_amount - amount_paid;
        const invoice_no = `INV-${Date.now()}`;
        const invRes = await pool.query(
            'INSERT INTO invoices (customer_id, invoice_no, total_amount, amount_paid, balance_due, payment_mode) VALUES ($1, $2, $3, $4, $5, $6) RETURNING invoice_id',
            [custId, invoice_no, total_amount, amount_paid, balance_due, payment_mode]
        );
        const invId = invRes.rows[0].invoice_id;

        // 3. Update Khata (If Part Payment)
        if (balance_due > 0) {
            await pool.query('UPDATE customers SET outstanding_balance = outstanding_balance + $1 WHERE customer_id = $2', [balance_due, custId]);
        }

        // 4. Insert Items & Minus Inventory
        for (let item of items) {
            await pool.query('INSERT INTO invoice_items (invoice_id, product_name, qty, warranty_months) VALUES ($1, $2, $3, $4)', [invId, item.name, item.qty, item.warranty_months || 12]);
            await pool.query('UPDATE products SET stock_quantity = stock_quantity - $1 WHERE product_name = $2', [item.qty, item.name]);
        }

        // 5. Trigger Delivery if large items
        await pool.query('INSERT INTO deliveries (invoice_id, status) VALUES ($1, $2)', [invId, 'Booked']);

        await pool.query('COMMIT'); // Save everything
        res.json({ success: true, invoice_no });
    } catch (err) { 
        await pool.query('ROLLBACK'); // Cancel if error
        res.status(500).json({ error: err.message }); 
    }
});

// ==========================================
// 4. DELIVERY & INSTALLATION TRACKER
// ==========================================
app.get('/api/deliveries/pending', async (req, res) => {
    try {
        const query = `
            SELECT d.delivery_id, i.invoice_no, c.name as customer_name, c.phone, i.remarks as address, d.status, d.delivery_date 
            FROM deliveries d JOIN invoices i ON d.invoice_id = i.invoice_id JOIN customers c ON i.customer_id = c.customer_id
            WHERE d.status != 'Installed' ORDER BY d.delivery_date ASC;
        `;
        const result = await pool.query(query);
        res.json({ success: true, data: result.rows });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/deliveries/update_status', async (req, res) => {
    const { invoice_no, status } = req.body;
    try {
        await pool.query('UPDATE deliveries SET status = $1 WHERE invoice_id = (SELECT invoice_id FROM invoices WHERE invoice_no = $2)', [status, invoice_no]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==========================================
// 5. CUSTOMER CRM & TIMELINE
// ==========================================
app.get('/api/customers/search', async (req, res) => {
    const { phone } = req.query;
    try {
        const custRes = await pool.query(`
            SELECT customer_id, name, phone, outstanding_balance, 
            (SELECT COALESCE(SUM(total_amount), 0) FROM invoices WHERE customer_id = customers.customer_id AND is_deleted = false) as total_purchase 
            FROM customers WHERE phone = $1;
        `, [phone]);

        if (custRes.rows.length === 0) return res.json({ success: false, message: "Not found" });

        const customer = custRes.rows[0];
        const timelineRes = await pool.query(`SELECT invoice_no, TO_CHAR(invoice_date, 'DD Mon YYYY') as date, payment_mode, total_amount FROM invoices WHERE customer_id = $1 AND is_deleted = false ORDER BY invoice_date DESC LIMIT 5;`, [customer.customer_id]);

        res.json({ success: true, customer: customer, timeline: timelineRes.rows });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==========================================
// 6. SERVICE, COMPLAINTS & WARRANTY
// ==========================================
app.get('/api/service/customer_products', async (req, res) => {
    const { phone } = req.query;
    try {
        const custRes = await pool.query('SELECT customer_id, name, phone FROM customers WHERE phone = $1', [phone]);
        if (custRes.rows.length === 0) return res.json({ success: false });

        const itemRes = await pool.query(`
            SELECT ii.item_id, ii.product_name, ii.warranty_months, i.invoice_no, i.invoice_date 
            FROM invoice_items ii JOIN invoices i ON ii.invoice_id = i.invoice_id
            WHERE i.customer_id = $1 AND i.is_deleted = false ORDER BY i.invoice_date DESC;
        `, [custRes.rows[0].customer_id]);

        res.json({ success: true, customer: custRes.rows[0], products: itemRes.rows });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/service/complaints/add', async (req, res) => {
    const { customer_id, item_id, issue_description, assigned_to } = req.body;
    try {
        await pool.query('INSERT INTO complaints (customer_id, item_id, issue_description, assigned_to, status) VALUES ($1, $2, $3, $4, \'Pending\')', [customer_id, item_id, issue_description, assigned_to || 'Unassigned']);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/service/dashboard', async (req, res) => {
    try {
        const summary = await pool.query(`SELECT COUNT(*) as total, SUM(CASE WHEN status IN ('Pending','In Progress') THEN 1 ELSE 0 END) as pending, SUM(CASE WHEN status = 'Resolved' THEN 1 ELSE 0 END) as resolved FROM complaints`);
        const list = await pool.query(`SELECT c.id, c.issue_description, c.status, c.assigned_to, cust.name as customer_name, ii.product_name FROM complaints c JOIN customers cust ON c.customer_id = cust.customer_id JOIN invoice_items ii ON c.item_id = ii.item_id ORDER BY c.id DESC;`);
        
        res.json({ success: true, summary: summary.rows[0], complaints: list.rows });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==========================================
// 7. SUPPLIER PROCUREMENT & INVENTORY
// ==========================================
app.get('/api/suppliers/ledger', async (req, res) => {
    const { supplier_id } = req.query;
    try {
        const sup = await pool.query('SELECT * FROM suppliers WHERE supplier_id = $1', [supplier_id]);
        if(sup.rows.length === 0) return res.json({ success: false });
        const bills = await pool.query('SELECT * FROM purchase_bills WHERE supplier_id = $1 ORDER BY bill_date DESC', [supplier_id]);
        res.json({ success: true, supplier: sup.rows[0], bills: bills.rows });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/suppliers/purchase', async (req, res) => {
    const { supplier_id, invoice_no, total_amount, items } = req.body;
    try {
        await pool.query('BEGIN');
        const bill = await pool.query('INSERT INTO purchase_bills (supplier_id, invoice_no, total_amount, status) VALUES ($1, $2, $3, \'Pending\') RETURNING bill_id', [supplier_id, invoice_no, total_amount]);
        
        for (let item of items) {
            await pool.query('INSERT INTO purchase_items (bill_id, product_name, qty, buying_price) VALUES ($1, $2, $3, $4)', [bill.rows[0].bill_id, item.product_name, item.qty, item.price]);
            const prod = await pool.query('SELECT * FROM products WHERE product_name = $1', [item.product_name]);
            if (prod.rows.length > 0) await pool.query('UPDATE products SET stock_quantity = stock_quantity + $1 WHERE product_name = $2', [item.qty, item.product_name]);
            else await pool.query('INSERT INTO products (product_name, base_price, stock_quantity) VALUES ($1, $2, $3)', [item.product_name, item.price * 1.2, item.qty]);
        }
        await pool.query('UPDATE suppliers SET outstanding_balance = outstanding_balance + $1 WHERE supplier_id = $2', [total_amount, supplier_id]);
        await pool.query('COMMIT');
        res.json({ success: true });
    } catch (err) { await pool.query('ROLLBACK'); res.status(500).json({ error: err.message }); }
});

app.post('/api/suppliers/return', async (req, res) => {
    const { supplier_id, product_name, qty, cn_amount, reason } = req.body;
    try {
        await pool.query('BEGIN');
        await pool.query('INSERT INTO supplier_returns (supplier_id, product_name, qty, cn_amount, reason) VALUES ($1, $2, $3, $4, $5)', [supplier_id, product_name, qty, cn_amount, reason]);
        await pool.query('UPDATE products SET stock_quantity = stock_quantity - $1 WHERE product_name = $2', [qty, product_name]);
        await pool.query('UPDATE suppliers SET outstanding_balance = outstanding_balance - $1 WHERE supplier_id = $2', [cn_amount, supplier_id]);
        await pool.query('COMMIT');
        res.json({ success: true });
    } catch (err) { await pool.query('ROLLBACK'); res.status(500).json({ error: err.message }); }
});

app.post('/api/suppliers/pay_bill', async (req, res) => {
    const { supplier_id, bill_id, amount, payment_mode, ref_no } = req.body;
    try {
        await pool.query('BEGIN');
        await pool.query('INSERT INTO supplier_payments (supplier_id, amount, remarks) VALUES ($1, $2, $3)', [supplier_id, amount, `${payment_mode} - Ref: ${ref_no}`]);
        await pool.query('UPDATE purchase_bills SET amount_paid = amount_paid + $1, status = CASE WHEN (amount_paid + $1) >= total_amount THEN \'Paid\' ELSE \'Partial\' END WHERE bill_id = $2', [amount, bill_id]);
        await pool.query('UPDATE suppliers SET outstanding_balance = outstanding_balance - $1 WHERE supplier_id = $2', [amount, supplier_id]);
        await pool.query('COMMIT');
        res.json({ success: true });
    } catch (err) { await pool.query('ROLLBACK'); res.status(500).json({ error: err.message }); }
});

// ==========================================
// 8. HR, PAYROLL & ACCESS CONTROL
// ==========================================
app.get('/api/hr/employees_master', async (req, res) => {
    try {
        const emp = await pool.query(`
            SELECT e.emp_code, e.name, e.role, e.base_salary, e.access_rights,
            (SELECT COUNT(*) FROM attendance WHERE emp_code = e.emp_code AND date >= date_trunc('month', CURRENT_DATE)) as present_days
            FROM employees e ORDER BY e.name ASC;
        `);
        res.json({ success: true, data: emp.rows });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/hr/update_access', async (req, res) => {
    try {
        await pool.query('UPDATE employees SET access_rights = $1 WHERE emp_code = $2', [req.body.access_rights, req.body.emp_code]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/hr/generate_payroll', async (req, res) => {
    const { emp_code, month, present_days, net_salary } = req.body;
    try {
        await pool.query('INSERT INTO payroll (emp_code, salary_month, total_present, net_salary, status) VALUES ($1, $2, $3, $4, \'Paid\')', [emp_code, month, present_days, net_salary]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==========================================
// 9. ANALYTICS (Weekly Chart)
// ==========================================
app.get('/api/analytics/report', async (req, res) => {
    try {
        const weeklyResult = await pool.query(`SELECT EXTRACT(ISODOW FROM invoice_date) as day_of_week, COALESCE(SUM(total_amount), 0) as daily_total FROM invoices WHERE invoice_date >= CURRENT_DATE - INTERVAL '7 days' AND is_deleted = false GROUP BY day_of_week;`);
        let weeklySalesMap = [0, 0, 0, 0, 0, 0, 0];
        weeklyResult.rows.forEach(row => { weeklySalesMap[parseInt(row.day_of_week) - 1] = parseFloat(row.daily_total); });

        const topProducts = await pool.query(`SELECT product_name, COUNT(*) as qty_sold FROM invoice_items JOIN invoices ON invoice_items.invoice_id = invoices.invoice_id WHERE invoices.invoice_date >= date_trunc('month', CURRENT_DATE) AND invoices.is_deleted = false GROUP BY product_name ORDER BY qty_sold DESC LIMIT 3;`);
        res.json({ success: true, data: { weekly_sales: weeklySalesMap, top_products: topProducts.rows } });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// START SERVER
app.listen(port, () => {
    console.log(`Mangal & Sons Master ERP Server running securely on port ${port}`);
});
