const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

// === Config ===
const PORT = 5000;
const MONGODB_URI = 'mongodb+srv://ages27771:ages12345@cluster0.t2zpj0w.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0';
// const MONGODB_URI = 'mongodb+srv://service:services1234@cluster0.wxa147v.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0';
// const MONGODB_URI = 'mongodb+srv://service:services1234@cluster0.wxa147v.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0';
// Replace <username>, <password>, and <cluster> with your actual MongoDB Atlas credentials

// === App Setup ===
const app = express();
app.use(cors());
app.use(express.json());

// === MongoDB Connection ===
mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => console.log('✅ MongoDB connected'))
.catch(err => console.error('❌ MongoDB connection error:', err));

// === Schemas ===
const productSchema = new mongoose.Schema({
  model: String,
  product: String,
  hsnCode: String,
  quantity: Number,
  price: Number,
  igst: Number,
  discount: Number,
  totalAmount: Number
});

const courierSchema = new mongoose.Schema({
  dispatchLocation: String,
  deleiveryNote: String,
  dated: String,
  docket: String,
  buyer: String,
  otherRef: String,
  refernceNO: String,
  mode: String,
  invoiceno: String,
  currentdate: String,
  courierName: String,
  termsofdeleivery: String
});

const invoiceSchema = new mongoose.Schema({
  companyName: String,
  personName: String,
  gstuin: String,
  address: String,
  statename: String,
  contactNumber: String,
  companyFormation: String,
  courier: courierSchema,
  productDetails: [productSchema]
});

const Invoice = mongoose.model('Invoice', invoiceSchema);

// === API Routes ===

// GET all invoices
app.get('/api/Chalan', async (req, res) => {
  try {
    const invoices = await Invoice.find();
    res.json(invoices);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST a new invoice
app.post('/api/Chalan', async (req, res) => {
  try {
    const invoice = new Invoice(req.body);
    const savedInvoice = await invoice.save();
    res.status(201).json(savedInvoice);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PUT update invoice by ID
app.put('/api/Chalan/:id', async (req, res) => {
  try {
    const updated = await Invoice.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE invoice by ID
app.delete('/api/Chalan/:id', async (req, res) => {
  try {
    await Invoice.findByIdAndDelete(req.params.id);
    res.json({ message: 'Invoice deleted' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// === Start Server ===
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
