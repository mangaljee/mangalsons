const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

// Premium CORS and Payload limits (Base64 images ke liye 50MB)
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Database connection
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
    } catch (err) { res.status(400).json({ error: "Employee Code already exists." }); }
});

// ==========================================
// MODULE 2: ATTENDANCE & REWARDS
// ==========================================
app.post('/api/attendance/punch', async (req, res) => {
    const { emp_code, lat, lon, punch_type, photo } = req.body;
    try {
        const serverTime = new Date();
        const currentHour = serverTime.getHours() + 5; // IST Check
        const currentMin = serverTime.getMinutes() + 30;

        const checkExisting = await pool.query('SELECT * FROM attendance WHERE emp_code = $1 AND attendance_date = CURRENT_DATE', [emp_code]);

        if (checkExisting.rows.length === 0) {
            await pool.query('INSERT INTO attendance (emp_code, punch_location_lat, punch_location_lon, photo) VALUES ($1, $2, $3, $4)', [emp_code, lat, lon, photo]);
            
            if (currentHour < 10 || (currentHour === 10 && currentMin <= 15)) {
                await pool.query('UPDATE employees SET points = points + 10, current_streak = current_streak + 1 WHERE emp_code = $1', [emp_code]);
                return res.json({ success: true, message: "Morning Check-In Done! Early Bird: +10 Points!" });
            } else {
                await pool.query('UPDATE employees SET current_streak = 0 WHERE emp_code = $1', [emp_code]);
                return res.json({ success: true, message: "Morning Check-In Done! You were late today." });
            }
        }

        const record = checkExisting.rows[0];
        if (punch_type === "CHECK_OUT" && record.check_out_time === null) {
            await pool.query('UPDATE attendance SET check_out_time = CURRENT_TIMESTAMP WHERE id = $1', [record.id]);
            return res.json({ success: true, message: "Evening Check-Out complete." });
        }
        res.status(400).json({ success: false, message: "Action sequence invalid or already completed." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==========================================
// MODULE 3: MULTI-GODOWN INVENTORY (Phase 3)
// ==========================================
// 3A. Autocomplete Search API (For Billing UI)
app.get('/api/products/search', async (req, res) => {
    const { query } = req.query;
    try {
        const result = await pool.query(
            "SELECT product_id, product_name, category, sub_category, base_price, stock_quantity FROM products WHERE product_name ILIKE $1 AND stock_quantity > 0 LIMIT 10",
            [`%${query}%`]
        );
        res.json({ success: true, data: result.rows });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// 3B. Procure Inventory to Specific Godown
app.post('/api/inventory/procure', async (req, res) => {
    const { product_name, category, sub_category, base_price, gst_percent, serial_numbers, quantity, godown_id, supplier_id } = req.body;
    try {
        await pool.query('BEGIN');

        let prodRes = await pool.query('SELECT product_id FROM products WHERE product_name = $1', [product_name]);
        let prodId;

        if (prodRes.rows.length === 0) {
            const insertProd = await pool.query(
                'INSERT INTO products (product_name, category, sub_category, base_price, gst_percent, stock_quantity) VALUES ($1, $2, $3, $4, $5, $6) RETURNING product_id',
                [product_name, category, sub_category || null, base_price, gst_percent || 18, quantity]
            );
            prodId = insertProd.rows[0].product_id;
        } else {
            prodId = prodRes.rows[0].product_id;
            await pool.query('UPDATE products SET stock_quantity = stock_quantity + $1 WHERE product_id = $2', [quantity, prodId]);
        }

        // Add to Godown
        if(godown_id) {
            await pool.query(
                'INSERT INTO godown_stock (product_id, godown_id, quantity) VALUES ($1, $2, $3) ON CONFLICT (product_id, godown_id) DO UPDATE SET quantity = godown_stock.quantity + $3',
                [prodId, godown_id, quantity]
            );
        }

        // Add Serials if Electronics
        if (category === 'Electronics' && serial_numbers && serial_numbers.length > 0) {
            for (let sn of serial_numbers) {
                await pool.query('INSERT INTO product_serials (product_id, serial_number) VALUES ($1, $2) ON CONFLICT DO NOTHING', [prodId, sn]);
            }
        }

        await pool.query('COMMIT');
        res.json({ success: true, message: "Stock successfully added to Godown & Main Inventory!" });
    } catch (err) {
        await pool.query('ROLLBACK');
        res.status(500).json({ success: false, error: err.message });
    }
});

// ==========================================
// MODULE 4: SMART BILLING & RETURN (Phase 3)
// ==========================================
app.post('/api/billing/create', async (req, res) => {
    // Naye fields: payment_mode (CASH/UPI) aur remarks added
    const { customer_phone, customer_name, is_gst_bill, total_amount, amount_paid, items, payment_mode, remarks } = req.body;
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

        // Insert Invoice with Payment Mode & Remarks
        const invRes = await pool.query(
            'INSERT INTO invoices (customer_id, invoice_no, total_amount, amount_paid, balance_due, is_gst_bill, payment_mode, remarks) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING invoice_id',
            [custId, invoice_no, total_amount, amount_paid, balance_due, is_gst_bill, payment_mode || 'CASH', remarks || null]
        );
        const invoiceId = invRes.rows[0].invoice_id;

        // Auto Khata Update
        if (balance_due > 0) {
            await pool.query('UPDATE customers SET outstanding_balance = outstanding_balance + $1 WHERE customer_id = $2', [balance_due, custId]);
        }

        // Deduct Stock & Map Serials
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
        res.json({ success: true, message: "Invoice generated successfully!", invoice_no: invoice_no });
    } catch (err) {
        await pool.query('ROLLBACK');
        res.status(500).json({ success: false, error: err.message });
    }
});

// 4B. Soft Delete / Return Invoice API
app.post('/api/billing/cancel/:invoice_id', async (req, res) => {
    const { invoice_id } = req.params;
    try {
        await pool.query('BEGIN');
        
        const invCheck = await pool.query('SELECT * FROM invoices WHERE invoice_id = $1 AND is_deleted = false', [invoice_id]);
        if(invCheck.rows.length === 0) throw new Error("Bill not found or already cancelled.");
        const invoice = invCheck.rows[0];

        await pool.query('UPDATE invoices SET is_deleted = true, remarks = $1 WHERE invoice_id = $2', ['CANCELLED & RETURNED', invoice_id]);

        if(invoice.balance_due > 0) {
            await pool.query('UPDATE customers SET outstanding_balance = outstanding_balance - $1 WHERE customer_id = $2', [invoice.balance_due, invoice.customer_id]);
        }

        const items = await pool.query('SELECT * FROM invoice_items WHERE invoice_id = $1', [invoice_id]);
        for(let item of items.rows) {
            await pool.query('UPDATE products SET stock_quantity = stock_quantity + 1 WHERE product_name = $1', [item.product_name]);
            if(item.serial_number) {
                await pool.query('UPDATE product_serials SET status = $1, sold_invoice_id = NULL WHERE serial_number = $2', ['IN_STOCK', item.serial_number]);
            }
        }

        await pool.query('COMMIT');
        res.json({ success: true, message: "Bill Cancelled and stock returned successfully!" });
    } catch (err) {
        await pool.query('ROLLBACK');
        res.status(500).json({ success: false, error: err.message });
    }
});

// ==========================================
// MODULE 5: EOD SALES REPORT (Phase 3)
// ==========================================
app.get('/api/analytics/eod-report', async (req, res) => {
    const { date } = req.query; // format: 'YYYY-MM-DD'
    try {
        const report = await pool.query(`
            SELECT 
                payment_mode,
                COUNT(invoice_id) as total_bills,
                SUM(total_amount) as total_sales,
                SUM(amount_paid) as cash_in_hand,
                SUM(balance_due) as market_udhaar
            FROM invoices 
            WHERE invoice_date::date = $1 AND is_deleted = false
            GROUP BY payment_mode
        `, [date]);
        res.json({ success: true, date: date, data: report.rows });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ==========================================
// MODULE 6: WARRANTY & COMPLAINTS
// ==========================================
app.get('/api/customer/search', async (req, res) => {
    const { phone } = req.query;
    try {
        const customerResult = await pool.query('SELECT * FROM customers WHERE phone = $1', [phone]);
        if (customerResult.rows.length === 0) return res.json({ success: false, message: "Customer account not found." });

        const customer = customerResult.rows[0];

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

app.listen(port, () => console.log(`Unified Master ERP Phase 3 Service running on port ${port}`));
