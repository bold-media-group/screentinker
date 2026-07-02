'use strict';

// #146 BILLING — admin-gated Usage Report (ByteTinker–Bold agreement §4.1 system-of-record
// / §4.2 verification). DELIBERATELY a standalone route, separate from routes/status.js:
// /api/status is the hot, constantly-polled path; this is a heavier admin-only aggregate
// and must not touch it. Reads the daily rollup ONLY (cheap — no raw-log scans).

const express = require('express');
const router = express.Router();
const { requirePlatformAdmin } = require('../middleware/auth');
const billing = require('../lib/billing');

// GET /api/billing/usage?month=YYYY-MM  (default: current month)
// Admin/platform-role gated with the SAME authz as other admin endpoints.
router.get('/usage', requirePlatformAdmin, (req, res) => {
  try {
    res.json(billing.buildUsageReport(req.query.month));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
