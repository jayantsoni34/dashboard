const express = require('express');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const cors = require('cors');
const compression = require('compression');
const NodeCache = require('node-cache');

const app = express();
// Cache dashboard stats for 5 minutes (300s). Adjust as needed.
const cache = new NodeCache({ stdTTL: 300 });

app.use(bodyParser.json());
app.use(cors());
app.use(compression());

const dbURI = 'mongodb+srv://oshan:oshan%40work1234@cluster0.2txxi.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0';
mongoose.connect(dbURI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('✅ Connected to MongoDB Atlas'))
  .catch((err) => {
    console.error('❌ Failed to connect to MongoDB:', err);
    process.exit(1);
  });

const taskSchema = new mongoose.Schema({
  complaintNumber: { type: String, index: true },
  name: String,
  email: String,
  phone: String,
  altPhone: String,
  state: String,
  city: String,
  pincode: String,
  location: String,
  landmark: String,
  product: String,
  selectedModel: {
    model: String,
    capacity: String,
    warranty: Number
  },
  serialNumber: String,
  warrantyStatus: {
    status: String,
    expiryDate: String
  },
  purchaseDate: String,
  installationDate: String,
  callType: String,
  condition: String,
  callSource: String,
  taskStatus: { type: String, index: true },   // indexed for aggregation
  assignEngineer: String,
  contactNo: String,
  dealer: String,
  date: { type: String, index: true },         // indexed — used for month/year filter
  asp: String,
  aspName: String,
  actionTaken: String,
  customerFeedback: String,
  enginnerNotes: String,
  images: [String],
  status: String,
  complaintNotes: String,
  additionalStatus: String,
  generatedOtps: String,
}, { timestamps: true });

const Task = mongoose.model('Task', taskSchema);

// Helper: clear all cache entries that start with a given prefix
const clearCachePrefix = (prefix) => {
  const keys = cache.keys();
  keys.forEach((k) => {
    if (k.startsWith(prefix)) cache.del(k);
  });
};

/* =========================================================
   ✅ DASHBOARD STATS ENDPOINT (NEW)
   GET /tasks/stats?month=0..11&year=YYYY
   Returns only aggregate counts — no full documents.
   ========================================================= */
app.get('/tasks/stats', async (req, res) => {
  try {
    const now = new Date();
    const month = req.query.month !== undefined
      ? parseInt(req.query.month, 10)
      : now.getMonth();
    const year = req.query.year !== undefined
      ? parseInt(req.query.year, 10)
      : now.getFullYear();

    if (isNaN(month) || month < 0 || month > 11) {
      return res.status(400).json({ error: 'Invalid month (0-11).' });
    }
    if (isNaN(year)) {
      return res.status(400).json({ error: 'Invalid year.' });
    }

    const cacheKey = `stats:${year}-${month}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      return res.status(200).json({ ...cached, cached: true });
    }

    // Build date range for the month, assuming `date` is stored as "YYYY-MM-DD"
    // (works for ISO strings too because string comparison on those prefixes is safe).
    const monthStr = String(month + 1).padStart(2, '0');
    const start = `${year}-${monthStr}-01`;
    const nextMonth = month === 11 ? 1 : month + 2;
    const nextYear = month === 11 ? year + 1 : year;
    const end = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`;

    const results = await Task.aggregate([
      { $match: { date: { $gte: start, $lt: end } } },
      { $group: { _id: '$taskStatus', count: { $sum: 1 } } }
    ]);

    const counts = { Assigned: 0, Pending: 0, Resolved: 0 };
    let total = 0;
    results.forEach((r) => {
      total += r.count;
      if (r._id && counts[r._id] !== undefined) {
        counts[r._id] = r.count;
      }
    });

    const payload = { total, counts, month, year };
    cache.set(cacheKey, payload);

    res.status(200).json(payload);
  } catch (err) {
    console.error('Error fetching stats:', err);
    res.status(500).json({ error: 'Failed to fetch stats.' });
  }
});

/* =========================================================
   Existing CRUD endpoints (unchanged contract)
   ========================================================= */
app.post('/tasks', async (req, res) => {
  try {
    const task = new Task(req.body);
    await task.save();
    clearCachePrefix('stats:');
    res.status(201).json(task);
  } catch (err) {
    console.error('Error saving task:', err);
    res.status(500).json({ error: 'Failed to save task.' });
  }
});


/* =========================================================
   ✅ CALENDAR AGGREGATION
   GET /tasks/calendar?month=0..11&year=YYYY&taskStatus=Pending|Resolved|Assigned
   Returns { days: { "1": {count, alert}, "2": {...}, ... }, total }
   ========================================================= */
app.get('/tasks/calendar', async (req, res) => {
  try {
    const now = new Date();
    const month = req.query.month !== undefined
      ? parseInt(req.query.month, 10)
      : now.getMonth();
    const year = req.query.year !== undefined
      ? parseInt(req.query.year, 10)
      : now.getFullYear();
    const taskStatus = req.query.taskStatus || '';

    if (isNaN(month) || month < 0 || month > 11) {
      return res.status(400).json({ error: 'Invalid month (0-11).' });
    }
    if (isNaN(year)) {
      return res.status(400).json({ error: 'Invalid year.' });
    }

    const cacheKey = `calendar:${year}-${month}:${taskStatus || 'ALL'}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      return res.status(200).json({ ...cached, cached: true });
    }

    const monthStr = String(month + 1).padStart(2, '0');
    const start = `${year}-${monthStr}-01`;
    const nextMonth = month === 11 ? 1 : month + 2;
    const nextYear = month === 11 ? year + 1 : year;
    const end = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`;

    const match = { date: { $gte: start, $lt: end } };
    if (taskStatus) match.taskStatus = taskStatus;

    // Pull only the fields we need (date + taskStatus) to compute age & alert.
    const rows = await Task.find(match, { date: 1, taskStatus: 1, _id: 0 }).lean();

    const nowMs = Date.now();
    const MS_PER_DAY = 1000 * 60 * 60 * 24;
    const days = {};
    let total = 0;

    for (const task of rows) {
      // Parse "YYYY-MM-DD" (or ISO string) → date parts
      const dateStr = String(task.date || '').slice(0, 10); // "YYYY-MM-DD"
      const [yStr, mStr, dStr] = dateStr.split('-');
      const day = parseInt(dStr, 10);
      if (!day || isNaN(day)) continue;

      const parsed = new Date(`${yStr}-${mStr}-${dStr}T00:00:00Z`);
      const diffDays = (nowMs - parsed.getTime()) / MS_PER_DAY;

      let alert = null;
      const status = (task.taskStatus || '').toLowerCase();
      if (status === 'pending' || status === 'assigned') {
        if (diffDays > 5) alert = 'red';
        else if (diffDays > 2) alert = 'yellow';
      }

      if (!days[day]) days[day] = { count: 0, alert: null };
      days[day].count += 1;
      total += 1;

      if (alert === 'red') days[day].alert = 'red';
      else if (alert === 'yellow' && days[day].alert !== 'red') {
        days[day].alert = 'yellow';
      }
    }

    const payload = { days, total, month, year, taskStatus: taskStatus || null };
    cache.set(cacheKey, payload);

    res.status(200).json(payload);
  } catch (err) {
    console.error('Error fetching calendar:', err);
    res.status(500).json({ error: 'Failed to fetch calendar.' });
  }
});

/* =========================================================
   ✅ PROBLEM BREAKDOWN BY ENGINEER NOTES
   GET /tasks/problems?month=0..11&year=YYYY
   Returns { breakdown: { "PCB Replaced": 12, ... }, total }
   Keys are the raw trimmed enginnerNotes values.
   ========================================================= */
app.get('/tasks/problems', async (req, res) => {
  try {
    const now = new Date();
    const month = req.query.month !== undefined
      ? parseInt(req.query.month, 10)
      : now.getMonth();
    const year = req.query.year !== undefined
      ? parseInt(req.query.year, 10)
      : now.getFullYear();

    if (isNaN(month) || month < 0 || month > 11) {
      return res.status(400).json({ error: 'Invalid month (0-11).' });
    }
    if (isNaN(year)) {
      return res.status(400).json({ error: 'Invalid year.' });
    }

    const cacheKey = `problems:${year}-${month}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      return res.status(200).json({ ...cached, cached: true });
    }

    const monthStr = String(month + 1).padStart(2, '0');
    const start = `${year}-${monthStr}-01`;
    const nextMonth = month === 11 ? 1 : month + 2;
    const nextYear = month === 11 ? year + 1 : year;
    const end = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`;

    const results = await Task.aggregate([
      {
        $match: {
          date: { $gte: start, $lt: end },
          enginnerNotes: { $exists: true, $nin: [null, ''] },
        }
      },
      {
        $group: {
          _id: { $trim: { input: '$enginnerNotes' } },
          count: { $sum: 1 }
        }
      }
    ]);

    const breakdown = {};
    let total = 0;
    results.forEach((r) => {
      if (!r._id) return;
      breakdown[r._id] = r.count;
      total += r.count;
    });

    const payload = { breakdown, total, month, year };
    cache.set(cacheKey, payload);

    res.status(200).json(payload);
  } catch (err) {
    console.error('Error fetching problems:', err);
    res.status(500).json({ error: 'Failed to fetch problems.' });
  }
});

/* =========================================================
   ✅ GLOBAL STATUS SUMMARY (ALL-TIME)
   GET /tasks/summary
   Returns { total, counts: { Assigned, Pending, Resolved } }
   - total   = total documents in collection
   - counts  = only the 3 statuses the chart plots
   ========================================================= */
app.get('/tasks/summary', async (req, res) => {
  try {
    const cacheKey = 'summary:global';
    const cached = cache.get(cacheKey);
    if (cached) {
      return res.status(200).json({ ...cached, cached: true });
    }

    const results = await Task.aggregate([
      { $group: { _id: '$taskStatus', count: { $sum: 1 } } }
    ]);

    const counts = { Assigned: 0, Pending: 0, Resolved: 0 };
    let total = 0;

    results.forEach((r) => {
      total += r.count;
      if (r._id && counts[r._id] !== undefined) {
        counts[r._id] = r.count;
      }
    });

    const payload = { total, counts };
    cache.set(cacheKey, payload);

    res.status(200).json(payload);
  } catch (err) {
    console.error('Error fetching summary:', err);
    res.status(500).json({ error: 'Failed to fetch summary.' });
  }
});

/* =========================================================
   ✅ REASON-STATUS BREAKDOWN
   GET /tasks/reasons?month=0..11&year=YYYY&taskStatus=Pending|Resolved|Assigned
   Returns total + count per additionalStatus within that taskStatus.
   ========================================================= */
app.get('/tasks/reasons', async (req, res) => {
  try {
    const now = new Date();
    const month = req.query.month !== undefined
      ? parseInt(req.query.month, 10)
      : now.getMonth();
    const year = req.query.year !== undefined
      ? parseInt(req.query.year, 10)
      : now.getFullYear();
    const taskStatus = req.query.taskStatus;

    if (isNaN(month) || month < 0 || month > 11) {
      return res.status(400).json({ error: 'Invalid month (0-11).' });
    }
    if (isNaN(year)) {
      return res.status(400).json({ error: 'Invalid year.' });
    }

    // If no taskStatus selected, frontend shows total = 0 — mirror that.
    if (!taskStatus) {
      return res.status(200).json({ total: 0, breakdown: {} });
    }

    const cacheKey = `reasons:${year}-${month}-${taskStatus}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      return res.status(200).json({ ...cached, cached: true });
    }

    const monthStr = String(month + 1).padStart(2, '0');
    const start = `${year}-${monthStr}-01`;
    const nextMonth = month === 11 ? 1 : month + 2;
    const nextYear = month === 11 ? year + 1 : year;
    const end = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`;

    const results = await Task.aggregate([
      {
        $match: {
          date: { $gte: start, $lt: end },
          taskStatus: taskStatus,
        }
      },
      {
        $group: {
          _id: '$additionalStatus',
          count: { $sum: 1 }
        }
      }
    ]);

    const breakdown = {};
    let total = 0;
    results.forEach((r) => {
      total += r.count;
      const key = r._id || 'Unspecified';
      breakdown[key] = r.count;
    });

    const payload = { total, breakdown };
    cache.set(cacheKey, payload);

    res.status(200).json(payload);
  } catch (err) {
    console.error('Error fetching reasons:', err);
    res.status(500).json({ error: 'Failed to fetch reasons.' });
  }
});

app.get('/tasks', async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const skip = (page - 1) * limit;

    const [totalTasks, tasks] = await Promise.all([
      Task.countDocuments(),
      Task.find().skip(skip).limit(limit).lean(),
    ]);

    res.status(200).json({
      tasks,
      totalTasks,
      currentPage: page,
      totalPages: Math.ceil(totalTasks / limit),
    });
  } catch (err) {
    console.error('Error fetching tasks:', err);
    res.status(500).json({ error: 'Failed to fetch tasks. Please try again.' });
  }
});

app.put('/tasks/:id', async (req, res) => {
  try {
    const task = await Task.findByIdAndUpdate(req.params.id, req.body, { new: true }).lean();
    if (!task) return res.status(404).json({ error: 'Task not found' });
    clearCachePrefix('stats:');
    res.status(200).json(task);
  } catch (err) {
    console.error('Error updating task:', err);
    res.status(500).json({ error: 'Failed to update task.' });
  }
});

app.delete('/tasks/:id', async (req, res) => {
  try {
    const task = await Task.findByIdAndDelete(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    clearCachePrefix('stats:');
    res.status(200).json({ message: 'Task deleted successfully' });
  } catch (err) {
    console.error('Error deleting task:', err);
    res.status(500).json({ error: 'Failed to delete task.' });
  }
});

const port = process.env.PORT || 5002;
app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});


// const express = require("express");
// const mongoose = require("mongoose");
// const cors = require("cors");
// const compression = require("compression");
// const NodeCache = require("node-cache");

// const app = express();

// app.use(cors());
// app.use(express.json({ limit: "10mb" }));
// app.use(compression());

// // ========================================
// // 🧠 Cache
// // ========================================
// const cache = new NodeCache({
//   stdTTL: 300, // 5 minutes
// });

// // ========================================
// // 🔗 MongoDB Connection
// // ========================================
// const MONGODB_URI =
//   "mongodb+srv://oshan:oshan%40work1234@cluster0.2txxi.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0";

// mongoose
//   .connect(MONGODB_URI, {
//     maxPoolSize: 10,
//   })
//   .then(() => console.log("✅ MongoDB Connected Successfully"))
//   .catch((err) => {
//     console.error("❌ MongoDB connection error:", err);
//   });

// // ========================================
// // 📦 Task Schema
// // ========================================
// const taskSchema = new mongoose.Schema(
//   {
//     complaintNumber: { type: String, index: true },
//     name: String,
//     email: String,
//     phone: String,
//     altPhone: String,
//     state: String,
//     city: String,
//     pincode: String,
//     location: String,
//     landmark: String,
//     product: String,
//     selectedModel: {
//       model: String,
//       capacity: String,
//       warranty: String,
//     },
//     serialNumber: String,
//     warrantyStatus: {
//       status: String,
//       expiryDate: String,
//     },
//     purchaseDate: String,
//     installationDate: String,
//     callType: String,
//     condition: String,
//     callSource: String,
//     taskStatus: String,
//     assignEngineer: String,
//     contactNo: String,
//     dealer: String,
//     date: String,
//     asp: String,
//     aspName: String,
//     actionTaken: String,
//     customerFeedback: String,
//     enginnerNotes: String,
//     images: [String],
//     status: String,
//     complaintNotes: String,
//     additionalStatus: String,
//     generatedOtps: String,
//   },
//   {
//     timestamps: true,
//   }
// );

// // ========================================
// // ⚡ Indexes
// // ========================================
// taskSchema.index({ complaintNumber: 1 });
// taskSchema.index({ serialNumber: 1 });
// taskSchema.index({ phone: 1 });
// taskSchema.index({ assignEngineer: 1 });
// taskSchema.index({ status: 1 });
// taskSchema.index({ taskStatus: 1 });
// taskSchema.index({ city: 1 });
// taskSchema.index({ date: 1 });
// taskSchema.index({ createdAt: -1 });

// const Task = mongoose.model("Task", taskSchema);

// // ========================================
// // 🛠️ HELPER: Parse month string
// // Supports: "2025-01", "01", "January", "Jan", 1
// // ========================================
// const MONTH_NAMES = {
//   january: 0, jan: 0,
//   february: 1, feb: 1,
//   march: 2, mar: 2,
//   april: 3, apr: 3,
//   may: 4,
//   june: 5, jun: 5,
//   july: 6, jul: 6,
//   august: 7, aug: 7,
//   september: 8, sep: 8, sept: 8,
//   october: 9, oct: 9,
//   november: 10, nov: 10,
//   december: 11, dec: 11,
// };

// function parseMonth(monthStr) {
//   if (monthStr === undefined || monthStr === null || monthStr === "") {
//     return null;
//   }

//   const str = String(monthStr).trim().toLowerCase();

//   // Format: "2025-01" or "2025-1"
//   const yyyymm = str.match(/^(\d{4})-(\d{1,2})$/);
//   if (yyyymm) {
//     const year = parseInt(yyyymm[1], 10);
//     const month = parseInt(yyyymm[2], 10) - 1;
//     if (month >= 0 && month <= 11) return { year, month };
//   }

//   // Format: "2025/01"
//   const yyyy_slash = str.match(/^(\d{4})\/(\d{1,2})$/);
//   if (yyyy_slash) {
//     const year = parseInt(yyyy_slash[1], 10);
//     const month = parseInt(yyyy_slash[2], 10) - 1;
//     if (month >= 0 && month <= 11) return { year, month };
//   }

//   // Format: month name (january, jan)
//   if (MONTH_NAMES[str] !== undefined) {
//     return { month: MONTH_NAMES[str] };
//   }

//   // Format: numeric 1-12
//   const num = parseInt(str, 10);
//   if (!isNaN(num) && num >= 1 && num <= 12) {
//     return { month: num - 1 };
//   }

//   return null;
// }

// // ========================================
// // 🛠️ HELPER: Build date range from query
// // ========================================
// function buildDateRange({ month, year, fromDate, toDate }) {
//   // Custom range takes priority
//   if (fromDate || toDate) {
//     const range = {};
//     if (fromDate) {
//       const start = new Date(fromDate);
//       if (!isNaN(start.getTime())) {
//         range.$gte = start;
//       }
//     }
//     if (toDate) {
//       const end = new Date(toDate);
//       if (!isNaN(end.getTime())) {
//         // Include full end day
//         end.setUTCHours(23, 59, 59, 999);
//         range.$lte = end;
//       }
//     }
//     return Object.keys(range).length ? range : null;
//   }

//   // Month-based range
//   if (!month && !year) return null;

//   const parsed = parseMonth(month);
//   const now = new Date();

//   let targetYear;
//   let targetMonth;

//   if (parsed) {
//     targetYear = parsed.year !== undefined ? parsed.year : (year ? parseInt(year, 10) : now.getUTCFullYear());
//     targetMonth = parsed.month;
//   } else if (year) {
//     // Year only — full year range
//     targetYear = parseInt(year, 10);
//     targetMonth = null;
//   } else {
//     return null;
//   }

//   let start, end;

//   if (targetMonth !== null && targetMonth !== undefined) {
//     start = new Date(Date.UTC(targetYear, targetMonth, 1, 0, 0, 0));
//     end = new Date(Date.UTC(targetYear, targetMonth + 1, 1, 0, 0, 0));
//   } else {
//     // Full year
//     start = new Date(Date.UTC(targetYear, 0, 1, 0, 0, 0));
//     end = new Date(Date.UTC(targetYear + 1, 0, 1, 0, 0, 0));
//   }

//   return { $gte: start, $lt: end };
// }

// // ========================================
// // ➕ ADD TASK
// // ========================================
// app.post("/tasks", async (req, res) => {
//   try {
//     const data = req.body;

//     let result;

//     if (Array.isArray(data)) {
//       result = await Task.insertMany(data, {
//         ordered: false,
//       });
//     } else {
//       const task = new Task(data);
//       result = await task.save();
//     }

//     cache.flushAll();

//     res.status(201).json(result);
//   } catch (err) {
//     console.error("❌ Error saving task:", err);

//     res.status(500).json({
//       error: "Failed to save task.",
//     });
//   }
// });

// // ========================================
// // 📋 GET TASKS (with month-wise filter)
// // ========================================
// app.get("/tasks", async (req, res) => {
//   try {
//     const {
//       complaintNumber,
//       username,
//       engineer,
//       status,
//       month,
//       year,
//       fromDate,
//       toDate,
//       dateField, // "createdAt" (default) or "date"
//     } = req.query;

//     // ========================================
//     // 🧠 Cache Key
//     // ========================================
//     const cacheKey = `tasks_${complaintNumber || "all"}_${
//       username || "all"
//     }_${engineer || "all"}_${status || "all"}_${month || "all"}_${
//       year || "all"
//     }_${fromDate || "all"}_${toDate || "all"}_${dateField || "createdAt"}`;

//     if (cache.has(cacheKey)) {
//       console.log("⚡ Cache Hit");
//       return res.json(cache.get(cacheKey));
//     }

//     console.log("🐢 Cache Miss - Fetching from DB");

//     // ========================================
//     // 🔎 Build Query
//     // ========================================
//     const query = {};

//     if (complaintNumber) {
//       query.complaintNumber = complaintNumber;
//     }

//     if (username) {
//       query.name = {
//         $regex: username,
//         $options: "i",
//       };
//     }

//     if (engineer) {
//       query.assignEngineer = engineer;
//     }

//     if (status) {
//       query.status = status;
//     }

//     // ========================================
//     // 📅 Month / Date Range Filter
//     // ========================================
//     const dateRange = buildDateRange({ month, year, fromDate, toDate });

//     if (dateRange) {
//       const field = dateField === "date" ? "date" : "createdAt";

//       if (field === "date") {
//         // `date` is a String field — convert range to ISO strings
//         const stringRange = {};
//         if (dateRange.$gte) {
//           stringRange.$gte = dateRange.$gte.toISOString().split("T")[0];
//         }
//         if (dateRange.$lt) {
//           stringRange.$lt = dateRange.$lt.toISOString().split("T")[0];
//         }
//         if (dateRange.$lte) {
//           stringRange.$lte = dateRange.$lte.toISOString().split("T")[0];
//         }
//         query.date = stringRange;
//       } else {
//         query.createdAt = dateRange;
//       }
//     }

//     // ========================================
//     // ⚡ FETCH
//     // ========================================
//     const data = await Task.find(query)
//       .select(
//         `
//         complaintNumber
//         name
//         phone
//         state
//         city
//         pincode
//         location
//         landmark
//         product
//         selectedModel
//         serialNumber
//         warrantyStatus
//         purchaseDate
//         installationDate
//         callType
//         condition
//         callSource
//         taskStatus
//         assignEngineer
//         contactNo
//         dealer
//         date
//         asp
//         aspName
//         status
//         additionalStatus
//         createdAt
//         updatedAt
//         `
//       )
//       .sort({ createdAt: -1 })
//       .lean();

//     cache.set(cacheKey, data);

//     console.log(`✅ Returned ${data.length} tasks`);

//     res.json(data);
//   } catch (err) {
//     console.error("❌ Fetch error:", err);

//     res.status(500).json({
//       error: "Failed to fetch tasks.",
//     });
//   }
// });

// // ========================================
// // 📊 GET MONTH-WISE SUMMARY
// // Returns count per month for a given year
// // ========================================
// app.get("/tasks/month-wise/summary", async (req, res) => {
//   try {
//     const { year, engineer, status } = req.query;

//     const targetYear = year
//       ? parseInt(year, 10)
//       : new Date().getUTCFullYear();

//     const cacheKey = `tasks_monthwise_${targetYear}_${engineer || "all"}_${
//       status || "all"
//     }`;

//     if (cache.has(cacheKey)) {
//       console.log("⚡ Cache Hit (month-wise)");
//       return res.json(cache.get(cacheKey));
//     }

//     const match = {
//       createdAt: {
//         $gte: new Date(Date.UTC(targetYear, 0, 1)),
//         $lt: new Date(Date.UTC(targetYear + 1, 0, 1)),
//       },
//     };

//     if (engineer) match.assignEngineer = engineer;
//     if (status) match.status = status;

//     const data = await Task.aggregate([
//       { $match: match },
//       {
//         $group: {
//           _id: {
//             year: { $year: "$createdAt" },
//             month: { $month: "$createdAt" },
//           },
//           count: { $sum: 1 },
//         },
//       },
//       { $sort: { "_id.month": 1 } },
//     ]);

//     // Fill all 12 months (0 if no data)
//     const monthNames = [
//       "January", "February", "March", "April", "May", "June",
//       "July", "August", "September", "October", "November", "December",
//     ];

//     const result = monthNames.map((name, idx) => {
//       const found = data.find((d) => d._id.month === idx + 1);
//       return {
//         month: idx + 1,
//         monthName: name,
//         year: targetYear,
//         count: found ? found.count : 0,
//       };
//     });

//     cache.set(cacheKey, result);

//     res.json({
//       year: targetYear,
//       total: result.reduce((sum, m) => sum + m.count, 0),
//       months: result,
//     });
//   } catch (err) {
//     console.error("❌ Month-wise summary error:", err);
//     res.status(500).json({
//       error: "Failed to fetch month-wise summary.",
//     });
//   }
// });

// // ========================================
// // 🔍 GET SINGLE TASK
// // ========================================
// app.get("/tasks/:id", async (req, res) => {
//   try {
//     const task = await Task.findById(req.params.id).lean();

//     if (!task) {
//       return res.status(404).json({ error: "Task not found" });
//     }

//     res.json(task);
//   } catch (err) {
//     console.error("❌ Fetch task error:", err);
//     res.status(500).json({ error: "Failed to fetch task" });
//   }
// });

// // ========================================
// // ✏️ UPDATE TASK
// // ========================================
// app.put("/tasks/:id", async (req, res) => {
//   try {
//     const task = await Task.findByIdAndUpdate(req.params.id, req.body, {
//       new: true,
//       runValidators: true,
//     }).lean();

//     if (!task) {
//       return res.status(404).json({ error: "Task not found" });
//     }

//     cache.flushAll();

//     res.json(task);
//   } catch (err) {
//     console.error("❌ Update error:", err);
//     res.status(500).json({ error: "Failed to update task." });
//   }
// });

// // ========================================
// // 🗑️ DELETE TASK
// // ========================================
// app.delete("/tasks/:id", async (req, res) => {
//   try {
//     const task = await Task.findByIdAndDelete(req.params.id);

//     if (!task) {
//       return res.status(404).json({ error: "Task not found" });
//     }

//     cache.flushAll();

//     res.json({ message: "Deleted successfully" });
//   } catch (err) {
//     console.error("❌ Delete error:", err);
//     res.status(500).json({ error: "Failed to delete task." });
//   }
// });

// // ========================================
// // 🌍 START SERVER
// // ========================================
// const PORT = process.env.PORT || 5002;

// app.listen(PORT, () => {
//   console.log(`🚀 Server running on port ${PORT}`);
// });

// // const express = require("express");
// // const mongoose = require("mongoose");
// // const cors = require("cors");
// // const compression = require("compression");
// // const NodeCache = require("node-cache");

// // const app = express();

// // app.use(cors());
// // app.use(express.json({ limit: "10mb" }));
// // app.use(compression());

// // // ========================================
// // // 🧠 Cache
// // // ========================================
// // const cache = new NodeCache({
// //   stdTTL: 300, // 5 minutes
// // });

// // // ========================================
// // // 🔗 MongoDB Connection
// // // ========================================
// // // const mongoose = require("mongoose");

// // const MONGODB_URI =
// //   "mongodb+srv://oshan:oshan%40work1234@cluster0.2txxi.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0";

// // mongoose
// //   .connect(MONGODB_URI, {
// //     maxPoolSize: 10,
// //   })
// //   .then(() => console.log("✅ MongoDB Connected Successfully"))
// //   .catch((err) => {
// //     console.error("❌ MongoDB connection error:", err);
// //   });

// // // ========================================
// // // 📦 Task Schema
// // // ========================================
// // const taskSchema = new mongoose.Schema(
// //   {
// //     complaintNumber: {
// //       type: String,
// //       index: true,
// //     },

// //     name: String,
// //     email: String,
// //     phone: String,
// //     altPhone: String,

// //     state: String,
// //     city: String,
// //     pincode: String,

// //     location: String,
// //     landmark: String,

// //     product: String,

// //     selectedModel: {
// //       model: String,
// //       capacity: String,
// //       warranty: Number,
// //     },

// //     serialNumber: String,

// //     warrantyStatus: {
// //       status: String,
// //       expiryDate: String,
// //     },

// //     purchaseDate: String,
// //     installationDate: String,

// //     callType: String,
// //     condition: String,
// //     callSource: String,

// //     taskStatus: String,

// //     assignEngineer: String,
// //     contactNo: String,

// //     dealer: String,

// //     date: String,

// //     asp: String,
// //     aspName: String,

// //     actionTaken: String,
// //     customerFeedback: String,
// //     enginnerNotes: String,

// //     images: [String],

// //     status: String,

// //     complaintNotes: String,
// //     additionalStatus: String,

// //     generatedOtps: String,
// //   },
// //   {
// //     timestamps: true,
// //   }
// // );

// // // ========================================
// // // ⚡ Indexes
// // // ========================================

// // taskSchema.index({ complaintNumber: 1 });
// // taskSchema.index({ serialNumber: 1 });
// // taskSchema.index({ phone: 1 });
// // taskSchema.index({ assignEngineer: 1 });
// // taskSchema.index({ status: 1 });
// // taskSchema.index({ taskStatus: 1 });
// // taskSchema.index({ city: 1 });
// // taskSchema.index({ date: 1 });
// // taskSchema.index({ createdAt: -1 });

// // const Task = mongoose.model("Task", taskSchema);

// // // ========================================
// // // ➕ ADD TASK
// // // ========================================
// // app.post("/tasks", async (req, res) => {
// //   try {
// //     const data = req.body;

// //     let result;

// //     if (Array.isArray(data)) {
// //       result = await Task.insertMany(data, {
// //         ordered: false,
// //       });
// //     } else {
// //       const task = new Task(data);
// //       result = await task.save();
// //     }

// //     // Clear task cache
// //     cache.flushAll();

// //     res.status(201).json(result);
// //   } catch (err) {
// //     console.error("❌ Error saving task:", err);

// //     res.status(500).json({
// //       error: "Failed to save task.",
// //     });
// //   }
// // });

// // // ========================================
// // // 📋 GET TASKS
// // // ========================================
// // app.get("/tasks", async (req, res) => {
// //   try {
// //     const {
// //       complaintNumber,
// //       username,
// //       engineer,
// //       status,
// //       month,
// //     } = req.query;

// //     // ========================================
// //     // 🧠 Cache Key
// //     // ========================================

// //     const cacheKey = `tasks_${complaintNumber || "all"}_${
// //       username || "all"
// //     }_${engineer || "all"}_${status || "all"}_${month || "all"}`;

// //     // ========================================
// //     // ⚡ Cache Check
// //     // ========================================

// //     if (cache.has(cacheKey)) {
// //       console.log("⚡ Cache Hit");

// //       return res.json(cache.get(cacheKey));
// //     }

// //     console.log("🐢 Cache Miss - Fetching from DB");

// //     // ========================================
// //     // 🔎 Build Query
// //     // ========================================

// //     const query = {};

// //     if (complaintNumber) {
// //       query.complaintNumber = complaintNumber;
// //     }

// //     if (username) {
// //       query.name = {
// //         $regex: username,
// //         $options: "i",
// //       };
// //     }

// //     if (engineer) {
// //       query.assignEngineer = engineer;
// //     }

// //     if (status) {
// //       query.status = status;
// //     }

// //     // ========================================
// //     // 📅 Month Filter
// //     // ========================================

// //     if (month) {
// //       const start = new Date(`${month}-01T00:00:00Z`);

// //       const end = new Date(start);

// //       end.setUTCMonth(end.getUTCMonth() + 1);

// //       query.createdAt = {
// //         $gte: start,
// //         $lt: end,
// //       };
// //     }

// //     // ========================================
// //     // ⚡ FETCH
// //     // ========================================

// //     const data = await Task.find(query)
// //       .select(
// //         `
// //         complaintNumber
// //         name
// //         phone
// //         state
// //         city
// //         pincode
// //         location
// //         landmark
// //         product
// //         selectedModel
// //         serialNumber
// //         warrantyStatus
// //         purchaseDate
// //         installationDate
// //         callType
// //         condition
// //         callSource
// //         taskStatus
// //         assignEngineer
// //         contactNo
// //         dealer
// //         date
// //         asp
// //         aspName
// //         status
// //         additionalStatus
// //         createdAt
// //         updatedAt
// //         `
// //       )
// //       .sort({
// //         createdAt: -1,
// //       })
// //       .lean();

// //     // ========================================
// //     // 🧠 Save in Cache
// //     // ========================================

// //     cache.set(cacheKey, data);

// //     console.log(`✅ Returned ${data.length} tasks`);

// //     res.json(data);
// //   } catch (err) {
// //     console.error("❌ Fetch error:", err);

// //     res.status(500).json({
// //       error: "Failed to fetch tasks.",
// //     });
// //   }
// // });

// // // ========================================
// // // 🔍 GET SINGLE TASK
// // // ========================================
// // app.get("/tasks/:id", async (req, res) => {
// //   try {
// //     const task = await Task.findById(req.params.id).lean();

// //     if (!task) {
// //       return res.status(404).json({
// //         error: "Task not found",
// //       });
// //     }

// //     res.json(task);
// //   } catch (err) {
// //     console.error("❌ Fetch task error:", err);

// //     res.status(500).json({
// //       error: "Failed to fetch task",
// //     });
// //   }
// // });

// // // ========================================
// // // ✏️ UPDATE TASK
// // // ========================================
// // app.put("/tasks/:id", async (req, res) => {
// //   try {
// //     const task = await Task.findByIdAndUpdate(
// //       req.params.id,
// //       req.body,
// //       {
// //         new: true,
// //         runValidators: true,
// //       }
// //     ).lean();

// //     if (!task) {
// //       return res.status(404).json({
// //         error: "Task not found",
// //       });
// //     }

// //     // Clear cache
// //     cache.flushAll();

// //     res.json(task);
// //   } catch (err) {
// //     console.error("❌ Update error:", err);

// //     res.status(500).json({
// //       error: "Failed to update task.",
// //     });
// //   }
// // });

// // // ========================================
// // // 🗑️ DELETE TASK
// // // ========================================
// // app.delete("/tasks/:id", async (req, res) => {
// //   try {
// //     const task = await Task.findByIdAndDelete(req.params.id);

// //     if (!task) {
// //       return res.status(404).json({
// //         error: "Task not found",
// //       });
// //     }

// //     // Clear cache
// //     cache.flushAll();

// //     res.json({
// //       message: "Deleted successfully",
// //     });
// //   } catch (err) {
// //     console.error("❌ Delete error:", err);

// //     res.status(500).json({
// //       error: "Failed to delete task.",
// //     });
// //   }
// // });

// // // ========================================
// // // 🌍 START SERVER
// // // ========================================
// // const PORT = process.env.PORT || 5002;

// // app.listen(PORT, () => {
// //   console.log(`🚀 Server running on port ${PORT}`);
// // });
