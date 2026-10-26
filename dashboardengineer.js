const express = require('express');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();

app.use(bodyParser.json({ limit: '10mb' }));
app.use(cors());

// Use environment variable on Railway
const dbURI = process.env.MONGO_URI;

// MongoDB connection
mongoose.connect(dbURI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log("Connected to MongoDB"))
  .catch((err) => {
    console.error("MongoDB Connection Error:", err);
    process.exit(1);
  });

// Schema
const taskSchema = new mongoose.Schema({
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
  selectedModel: Object,
  serialNumber: String,
  warrantyStatus: Object,
  purchaseDate: String,
  installationDate: String,
  status: String,
  complaintNumber: String,
  callType: String,
  additionalStatus: String,
  callSource: String,
  taskStatus: String,
  assignEngineer: String,
  contactNo: String,
  dealer: String,
  complaintNotes: String,
  enginnerNotes: String,
  customerFeedback: String,
  date: String,
  asp: String,
  aspName: String,
  actionTaken: String,
  images: [String],
}, { timestamps: true });

// ============================================================
// DATABASE INDEXES
// ============================================================

// Index on `date` for fast month-based filtering & sorting
taskSchema.index({ date: -1 });

// Index on `createdAt` (from timestamps) as a fallback for time-based queries
taskSchema.index({ createdAt: -1 });

// Indexes on frequently filtered fields
taskSchema.index({ status: 1 });
taskSchema.index({ taskStatus: 1 });
taskSchema.index({ assignEngineer: 1 });
taskSchema.index({ complaintNumber: 1 });
taskSchema.index({ serialNumber: 1 });
taskSchema.index({ phone: 1 });
taskSchema.index({ email: 1 });
taskSchema.index({ state: 1 });
taskSchema.index({ city: 1 });
taskSchema.index({ pincode: 1 });
taskSchema.index({ product: 1 });
taskSchema.index({ dealer: 1 });
taskSchema.index({ asp: 1 });
taskSchema.index({ callType: 1 });
taskSchema.index({ callSource: 1 });
taskSchema.index({ additionalStatus: 1 });

// Compound index: month + status (common combined filter)
taskSchema.index({ date: -1, status: 1 });
taskSchema.index({ date: -1, taskStatus: 1 });
taskSchema.index({ date: -1, assignEngineer: 1 });

// Text index for search across multiple fields
taskSchema.index({
  name: 'text',
  email: 'text',
  phone: 'text',
  complaintNumber: 'text',
  serialNumber: 'text',
  city: 'text',
  location: 'text',
  dealer: 'text',
  assignEngineer: 'text',
});

// ============================================================
// HELPER: Build date range from month + year
// ============================================================
function buildDateRange(month, year) {
  // month: 1-12, year: e.g. 2025
  const start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
  return { start, end };
}

// ============================================================
// ROUTES
// ============================================================

// POST /tasks - Create a new task
app.post('/tasks', async (req, res) => {
  try {
    const task = new Task(req.body);
    await task.save();
    res.status(201).json(task);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to save task" });
  }
});

// ============================================================
// GET /tasks - Paginated + Month filter + Optional filters
// Query params:
//   month=1-12   (optional)
//   year=2025    (optional, default current year)
//   page=1       (optional, default 1)
//   limit=100    (optional, max 100, default 100)
//   status, taskStatus, assignEngineer, search (optional)
// ============================================================
app.get('/tasks', async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);

    // Hard cap at 100 per request
    const requestedLimit = parseInt(req.query.limit) || 100;
    const limit = Math.min(Math.max(requestedLimit, 1), 100);

    const skip = (page - 1) * limit;

    // Build filter
    const filter = {};

    // Month + Year filter (based on `date` field)
    if (req.query.month) {
      const month = parseInt(req.query.month);
      const year = parseInt(req.query.year) || new Date().getFullYear();

      if (month >= 1 && month <= 12) {
        const { start, end } = buildDateRange(month, year);

        // `date` is stored as String, so we match by string prefix YYYY-MM
        // This works for ISO-like formats: "2025-01-15", "2025-01-15T10:00:00Z"
        const monthPrefix = `${year}-${String(month).padStart(2, '0')}`;
        filter.date = { $regex: `^${monthPrefix}` };
      }
    }

    // Optional equality filters
    const equalityFields = [
      'status', 'taskStatus', 'assignEngineer', 'product',
      'dealer', 'asp', 'callType', 'callSource',
      'additionalStatus', 'state', 'city', 'pincode',
    ];
    for (const field of equalityFields) {
      if (req.query[field]) {
        filter[field] = req.query[field];
      }
    }

    // Optional search (uses text index)
    if (req.query.search) {
      filter.$text = { $search: req.query.search };
    }

    // Execute query with pagination + projection for speed
    const [tasks, total] = await Promise.all([
      Task.find(filter)
        .sort({ date: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(), // faster, plain JS objects
      Task.countDocuments(filter),
    ]);

    res.status(200).json({
      data: tasks,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasNextPage: page * limit < total,
        hasPrevPage: page > 1,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch tasks" });
  }
});

// ============================================================
// GET /tasks/stats - Aggregate counts by month (optional helper)
// Query: year=2025
// ============================================================
app.get('/tasks/stats/monthly', async (req, res) => {
  try {
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const yearPrefix = `${year}-`;

    const stats = await Task.aggregate([
      { $match: { date: { $regex: `^${yearPrefix}` } } },
      {
        $group: {
          _id: { $substr: ['$date', 0, 7] }, // YYYY-MM
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    res.status(200).json({ year, stats });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

// PUT /tasks/:id - Update
app.put('/tasks/:id', async (req, res) => {
  try {
    const task = await Task.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!task) return res.status(404).json({ error: "Task not found" });
    res.json(task);
  } catch (err) {
    res.status(500).json({ error: "Failed to update task" });
  }
});

// DELETE /tasks/:id
app.delete('/tasks/:id', async (req, res) => {
  try {
    const task = await Task.findByIdAndDelete(req.params.id);
    if (!task) return res.status(404).json({ error: "Task not found" });
    res.json({ message: "Task deleted" });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete task" });
  }
});

// ============================================================
// Start server
// ============================================================
const port = process.env.PORT || 5002;
app.listen(port, () => console.log(`Server running on port ${port}`));





// const express = require("express");
// const mongoose = require("mongoose");
// const cors = require("cors");
// require("dotenv").config();

// const app = express();

// app.use(cors());
// app.use(express.json());

// // ===============================
// // MongoDB Connection
// // ===============================

// mongoose
//   .connect(process.env.MONGODB_URI)
//   .then(() => {
//     console.log("MongoDB Atlas connected successfully");
//   })
//   .catch((error) => {
//     console.error("MongoDB connection error:", error);
//   });

// // ===============================
// // MongoDB Schema
// // ===============================

// const entrySchema = new mongoose.Schema(
//   {
//     type: {
//       type: String,
//       required: true,
//       enum: [
//         "scheduled",
//         "issued",
//         "used",
//         "defective",
//       ],
//     },

//     complaintNo: {
//       type: String,
//       default: "",
//     },

//     complaint: {
//       type: String,
//       default: "",
//     },

//     customer: {
//       type: String,
//       default: "",
//     },

//     part: {
//       type: String,
//       default: "",
//     },

//     qty: {
//       type: Number,
//       default: 0,
//     },

//     date: {
//       type: String,
//       default: "",
//     },

//     serialNo: {
//       type: String,
//       default: "",
//     },

//     installedDate: {
//       type: String,
//       default: "",
//     },

//     oldSerial: {
//       type: String,
//       default: "",
//     },

//     status: {
//       type: String,
//       default: "",
//     },
//   },
//   {
//     timestamps: true,
//   }
// );

// const Entry = mongoose.model("TechnicianEntry", entrySchema);

// // ===============================
// // Test API
// // ===============================

// app.get("/", (req, res) => {
//   res.json({
//     message: "Technician Dashboard API is running",
//   });
// });

// // ===============================
// // GET ALL ENTRIES
// // ===============================

// app.get("/api/entries", async (req, res) => {
//   try {
//     const entries = await Entry.find().sort({
//       createdAt: -1,
//     });

//     res.json(entries);
//   } catch (error) {
//     console.error(error);

//     res.status(500).json({
//       message: "Failed to fetch entries",
//     });
//   }
// });

// // ===============================
// // GET ENTRIES BY TYPE
// // ===============================

// app.get("/api/entries/:type", async (req, res) => {
//   try {
//     const entries = await Entry.find({
//       type: req.params.type,
//     }).sort({
//       createdAt: -1,
//     });

//     res.json(entries);
//   } catch (error) {
//     console.error(error);

//     res.status(500).json({
//       message: "Failed to fetch entries",
//     });
//   }
// });

// // ===============================
// // ADD NEW ENTRY
// // ===============================

// app.post("/api/entries", async (req, res) => {
//   try {
//     const {
//       type,
//       complaintNo,
//       complaint,
//       customer,
//       part,
//       qty,
//       date,
//       serialNo,
//       installedDate,
//       oldSerial,
//       status,
//     } = req.body;

//     if (!type) {
//       return res.status(400).json({
//         message: "Entry type is required",
//       });
//     }

//     const validTypes = [
//       "scheduled",
//       "issued",
//       "used",
//       "defective",
//     ];

//     if (!validTypes.includes(type)) {
//       return res.status(400).json({
//         message: "Invalid entry type",
//       });
//     }

//     const newEntry = new Entry({
//       type,
//       complaintNo,
//       complaint,
//       customer,
//       part,
//       qty,
//       date,
//       serialNo,
//       installedDate,
//       oldSerial,
//       status,
//     });

//     const savedEntry = await newEntry.save();

//     res.status(201).json(savedEntry);
//   } catch (error) {
//     console.error(error);

//     res.status(500).json({
//       message: "Failed to save entry",
//       error: error.message,
//     });
//   }
// });

// // ===============================
// // ADD MULTIPLE ENTRIES AT ONCE
// // ===============================

// app.post("/api/entries/bulk", async (req, res) => {
//   try {
//     const { entries } = req.body;

//     if (!Array.isArray(entries)) {
//       return res.status(400).json({
//         message: "entries must be an array",
//       });
//     }

//     const validTypes = [
//       "scheduled",
//       "issued",
//       "used",
//       "defective",
//     ];

//     for (const entry of entries) {
//       if (!validTypes.includes(entry.type)) {
//         return res.status(400).json({
//           message: `Invalid type: ${entry.type}`,
//         });
//       }
//     }

//     const savedEntries = await Entry.insertMany(entries);

//     res.status(201).json(savedEntries);
//   } catch (error) {
//     console.error(error);

//     res.status(500).json({
//       message: "Failed to save entries",
//       error: error.message,
//     });
//   }
// });

// // ===============================
// // DELETE ENTRY
// // ===============================

// app.delete("/api/entries/:id", async (req, res) => {
//   try {
//     const entry = await Entry.findByIdAndDelete(
//       req.params.id
//     );

//     if (!entry) {
//       return res.status(404).json({
//         message: "Entry not found",
//       });
//     }

//     res.json({
//       message: "Entry deleted successfully",
//       id: req.params.id,
//     });
//   } catch (error) {
//     console.error(error);

//     res.status(500).json({
//       message: "Failed to delete entry",
//     });
//   }
// });

// // ===============================
// // UPDATE ENTRY
// // ===============================

// app.put("/api/entries/:id", async (req, res) => {
//   try {
//     const updatedEntry =
//       await Entry.findByIdAndUpdate(
//         req.params.id,
//         req.body,
//         {
//           new: true,
//           runValidators: true,
//         }
//       );

//     if (!updatedEntry) {
//       return res.status(404).json({
//         message: "Entry not found",
//       });
//     }

//     res.json(updatedEntry);
//   } catch (error) {
//     console.error(error);

//     res.status(500).json({
//       message: "Failed to update entry",
//     });
//   }
// });

// // ===============================
// // START SERVER
// // ===============================

// const PORT = process.env.PORT || 5000;

// app.listen(PORT, () => {
//   console.log(
//     `Server running on http://localhost:${PORT}`
//   );
// });
