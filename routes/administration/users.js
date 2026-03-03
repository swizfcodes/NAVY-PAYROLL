const express = require("express");
const router = express.Router();
const pool = require("../../config/db");
const config = require("../../config");
const jwt = require("jsonwebtoken");
const verifyToken = require("../../middware/authentication");

const jwtSign = ({ data, secret, time }) =>
  jwt.sign(data, secret, { expiresIn: time });

const jwtVerify = ({ token, secret }) =>
  jwt.verify(token, secret, (err, decoded) => {
    if (err) {
      return err.name === "TokenExpiredError"
        ? { message: "Token has expired", decoded: "" }
        : { message: "Invalid token", decoded: "" };
    }
    return { decoded, message: "" };
  });

// ============================================================
// HELPER — Build mapping from py_payrollclass
//
// py_payrollclass schema: classcode, classname, status, db_name
// Example row: 1, OFFICERS, active, hicaddata
//
// Produces:
//   dbToClass: { hicaddata: 'OFFICERS', hicaddata1: 'W.OFFICERS', ... }
//   classToDb: { OFFICERS: 'hicaddata', 'W.OFFICERS': 'hicaddata1', ... }
//
// Frontend always sends payroll_class as db_name ('hicaddata')
// DB stores user.primary_class as classname ('OFFICERS', 'W.OFFICERS')
// ============================================================
async function loadPayrollMapping() {
  let databasesToSearch = [];
  let dbToClass = {};
  let classToDb = {};

  try {
    const officersDb = process.env.DB_OFFICERS || config.databases.officers;
    pool.useDatabase(officersDb);

    const [rows] = await pool.query(
      "SELECT db_name, classname FROM py_payrollclass WHERE status = 'active'",
    );

    rows.forEach((row) => {
      dbToClass[row.db_name] = row.classname;
      classToDb[row.classname] = row.db_name;
    });

    const others = rows.map((r) => r.db_name).filter((db) => db !== officersDb);
    databasesToSearch = [officersDb, ...others];

    console.log("📋 Databases to search:", databasesToSearch);
    console.log("🔗 dbToClass:", dbToClass);
    console.log("🔗 classToDb:", classToDb);
  } catch (err) {
    console.warn(
      "⚠️ py_payrollclass load failed, using env fallback:",
      err.message,
    );
    databasesToSearch = [
      process.env.DB_OFFICERS,
      process.env.DB_WOFFICERS,
      process.env.DB_RATINGS,
      process.env.DB_RATINGS_A,
      process.env.DB_RATINGS_B,
      process.env.DB_JUNIOR_TRAINEE,
    ].filter(Boolean);
  }

  return { databasesToSearch, dbToClass, classToDb };
}

// Resolve user.primary_class (classname OR db_name) → db_name
function resolveToDbName(primaryClass, dbToClass, classToDb) {
  if (dbToClass[primaryClass]) return primaryClass; // already a db_name
  if (classToDb[primaryClass]) return classToDb[primaryClass]; // it's a classname
  return null;
}

// ============================================================
// PRE-LOGIN — User ID + Password only, no class
// ============================================================
router.post("/pre-login", async (req, res) => {
  const { user_id, password } = req.body;
  if (!user_id || !password)
    return res.status(400).json({ error: "User ID and password are required" });

  try {
    const { databasesToSearch } = await loadPayrollMapping();
    let foundUser = null,
      foundDatabase = null;

    for (const dbName of databasesToSearch) {
      if (!dbName) continue;
      try {
        pool.useDatabase(dbName);
        const [rows] = await pool.query(
          "SELECT * FROM users WHERE user_id = ?",
          [user_id],
        );
        if (rows.length) {
          foundUser = rows[0];
          foundDatabase = dbName;
          console.log(`✅ Pre-login: user found in ${dbName}`);
          break;
        }
      } catch (err) {
        console.log(`❌ Error searching ${dbName}:`, err.message);
      }
    }

    if (!foundUser)
      return res.status(401).json({ error: "Invalid User ID or password" });
    if (foundUser.password !== password)
      return res.status(401).json({ error: "Invalid User ID or password" });
    if (foundUser.status !== "active")
      return res
        .status(403)
        .json({ error: "Account is inactive or suspended" });

    if (foundUser.expiry_date) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      if (new Date(foundUser.expiry_date) < today)
        return res
          .status(403)
          .json({
            error: "Account has expired. Please contact administrator.",
          });
    }

    const token = jwtSign({
      data: {
        user_id: foundUser.user_id,
        full_name: foundUser.full_name,
        email: foundUser.email,
        role: foundUser.user_role,
        primary_class: foundUser.primary_class,
        created_in: foundDatabase,
      },
      secret: config.jwt.secret,
      time: "8h",
    });

    console.log(`✅ Pre-login successful for ${user_id}`);
    res.json({
      message: "✅ Pre-login successful",
      token,
      user: {
        user_id: foundUser.user_id,
        full_name: foundUser.full_name,
        email: foundUser.email,
        role: foundUser.user_role,
        status: foundUser.status,
        primary_class: foundUser.primary_class,
      },
    });
  } catch (err) {
    console.error("❌ Pre-login error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ============================================================
// LOGIN — Full login with payroll class
//
// Frontend sends payroll_class as db_name (e.g. 'hicaddata')
// DB stores user.primary_class as classname (e.g. 'OFFICERS')
//
// Match logic:
//   requestedDb   = payroll_class (already a db_name) or classToDb[payroll_class]
//   userPrimaryDb = classToDb[user.primary_class]     or user.primary_class if it's a db_name
//   classMatches  = userPrimaryDb === requestedDb
// ============================================================
router.post("/login", async (req, res) => {
  const { user_id, password, payroll_class } = req.body;
  console.log("Login attempt:", req.body);

  try {
    const { databasesToSearch, dbToClass, classToDb } =
      await loadPayrollMapping();

    // Resolve payroll_class → db_name
    let requestedDb = null;
    if (dbToClass[payroll_class])
      requestedDb = payroll_class; // it's a db_name
    else if (classToDb[payroll_class]) requestedDb = classToDb[payroll_class]; // it's a classname

    if (!requestedDb) {
      console.log(`❌ Cannot resolve payroll_class: '${payroll_class}'`);
      return res.status(400).json({ error: "Invalid payroll class selected" });
    }

    const requestedClassName = dbToClass[requestedDb];
    console.log(
      `✅ Resolved '${payroll_class}' → db:'${requestedDb}' class:'${requestedClassName}'`,
    );

    // Search all databases
    const userCandidates = [];
    for (const dbName of databasesToSearch) {
      if (!dbName) continue;
      try {
        pool.useDatabase(dbName);
        const [rows] = await pool.query(
          "SELECT * FROM users WHERE user_id = ?",
          [user_id],
        );
        if (rows.length) {
          userCandidates.push({ user: rows[0], database: dbName });
          console.log(`✅ User found in ${dbName}`);
        }
      } catch (err) {
        console.log(`❌ DB error (${dbName}):`, err.message);
      }
    }

    if (!userCandidates.length)
      return res.status(401).json({ error: "Invalid User ID or password" });

    // Find authenticated candidate
    let authenticatedUser = null,
      authenticatedDatabase = null;

    for (const { user, database } of userCandidates) {
      let isExpired = false;
      if (user.expiry_date) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        isExpired = new Date(user.expiry_date) < today;
      }

      const userPrimaryDb = resolveToDbName(
        user.primary_class,
        dbToClass,
        classToDb,
      );
      const classMatches = userPrimaryDb === requestedDb;

      console.log(
        `  [${database}] pw:${user.password === password} status:${user.status}` +
          ` expired:${isExpired} primary_class:'${user.primary_class}'` +
          ` → db:'${userPrimaryDb}' requestedDb:'${requestedDb}' match:${classMatches}`,
      );

      if (
        user.password === password &&
        user.status === "active" &&
        !isExpired &&
        classMatches
      ) {
        authenticatedUser = user;
        authenticatedDatabase = database;
        break;
      }
    }

    if (!authenticatedUser) {
      const pwOk = userCandidates.some((c) => c.user.password === password);
      const inactive = userCandidates.some((c) => c.user.status !== "active");
      const expired = userCandidates.some((c) => {
        if (!c.user.expiry_date) return false;
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        return new Date(c.user.expiry_date) < today;
      });
      const classMismatch = userCandidates.some(
        (c) =>
          resolveToDbName(c.user.primary_class, dbToClass, classToDb) !==
          requestedDb,
      );

      pool.useDatabase(config.databases.officers);

      if (expired && pwOk)
        return res
          .status(403)
          .json({
            error: "Account has expired. Please contact administrator.",
          });
      if (inactive && pwOk)
        return res
          .status(403)
          .json({ error: "Account is inactive or suspended." });
      if (classMismatch && pwOk)
        return res
          .status(403)
          .json({
            error:
              "Unauthorized payroll class. You can only login to your assigned class.",
          });
      return res.status(401).json({ error: "Invalid User ID or password" });
    }

    const tokenPayload = {
      user_id: authenticatedUser.user_id,
      full_name: authenticatedUser.full_name,
      email: authenticatedUser.email,
      role: authenticatedUser.user_role,
      primary_class: authenticatedUser.primary_class,
      current_class: requestedDb, // db_name e.g. 'hicaddata' — used by routes as DB prefix
      created_in: authenticatedDatabase,
    };

    const token = jwtSign({
      data: tokenPayload,
      secret: config.jwt.secret,
      time: "8h",
    });

    pool.useDatabase(authenticatedDatabase);
    await pool.query("UPDATE users SET token = ? WHERE user_id = ?", [
      token,
      user_id,
    ]);

    pool.useDatabase(requestedDb);
    console.log(`✅ Login successful for ${user_id} → db:${requestedDb}`);

    res.json({
      message: "✅ Login successful",
      token,
      user: {
        user_id: authenticatedUser.user_id,
        full_name: authenticatedUser.full_name,
        email: authenticatedUser.email,
        role: authenticatedUser.user_role,
        status: authenticatedUser.status,
        primary_class: authenticatedUser.primary_class,
        current_class: requestedClassName,
      },
    });
  } catch (err) {
    pool.useDatabase(config.databases.officers);
    console.error("❌ Login error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ============================================================
// LOGOUT
// ============================================================
router.post("/logout", verifyToken, async (req, res) => {
  try {
    const bearerHeader = req.headers["authorization"];
    let token = null;
    if (bearerHeader && bearerHeader.startsWith("Bearer "))
      token = bearerHeader.split(" ")[1];
    if (!token && req.query.token) token = req.query.token;
    if (!token) return res.status(403).json({ message: "No token provided" });

    pool.useDatabase(config.databases.officers);
    await pool.query("UPDATE users SET token = NULL WHERE user_id = ?", [
      req.user_id,
    ]);
    return res.status(204).send();
  } catch (err) {
    console.error("❌ Logout error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ============================================================
// REFRESH TOKEN
// ============================================================
router.post("/refresh", async (req, res) => {
  try {
    const { refresh_token } = req.body;
    if (!refresh_token)
      return res.status(400).json({ message: "Please Log In" });

    const { message, decoded } = jwtVerify({
      token: refresh_token,
      secret: config.jwt.refreshSecret,
    });
    if (message || !decoded) return res.status(400).json({ message });

    const { classToDb } = await loadPayrollMapping();
    const dbName = classToDb[decoded.created_in] || decoded.created_in;

    pool.useDatabase(dbName);
    const [userRows] = await pool.query(
      "SELECT * FROM users WHERE user_id = ?",
      [decoded.user_id],
    );
    if (!userRows.length)
      return res.status(404).json({ message: "User not found" });

    const user = userRows[0];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (
      (user.expiry_date && new Date(user.expiry_date) < today) ||
      user.status !== "active"
    )
      return res.status(401).json({ message: "Please Log In." });

    const token = jwtSign({
      data: {
        user_id: user.user_id,
        full_name: user.full_name,
        email: user.email,
        role: user.user_role,
        primary_class: user.primary_class,
        current_class: decoded.current_class,
        created_in: decoded.created_in,
      },
      secret: config.jwt.secret,
      time: "8h",
    });

    console.log(`🔄 Token refreshed for ${user.user_id}`);
    res.status(200).json({ message: "Token Refreshed", token });
  } catch (err) {
    console.error("❌ Refresh error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ============================================================
// USER CRUD
// ============================================================

router.get("/", verifyToken, async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT * FROM users ORDER BY full_name ASC",
    );
    res.json(rows);
  } catch (err) {
    console.error("❌ Error fetching users:", err);
    res.status(500).json({ error: "Database error" });
  }
});

router.get("/:id", verifyToken, async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM users WHERE user_id = ?", [
      req.params.id,
    ]);
    if (!rows.length) return res.status(404).json({ error: "User not found" });
    res.json(rows[0]);
  } catch (err) {
    console.error("❌ Error fetching user:", err);
    res.status(500).json({ error: "Database error" });
  }
});

router.post("/", verifyToken, async (req, res) => {
  const {
    user_id,
    fullName,
    payroll_class,
    email,
    role,
    status,
    phone,
    password,
    expiryDate,
  } = req.body;
  try {
    if (!user_id || !fullName || !email || !role || !payroll_class)
      return res
        .status(400)
        .json({
          error:
            "User ID, Payroll Class, full name, email, and role are required",
        });

    const validStatuses = ["active", "inactive", "suspended"];
    const userStatus = status || "active";
    if (!validStatuses.includes(userStatus))
      return res
        .status(400)
        .json({
          error: `Invalid status. Must be one of: ${validStatuses.join(", ")}`,
        });

    if (expiryDate) {
      const expiry = new Date(expiryDate);
      if (isNaN(expiry.getTime()))
        return res.status(400).json({ error: "Invalid expiry date format" });
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      if (expiry < today)
        return res
          .status(400)
          .json({ error: "Expiry date cannot be in the past" });
    }

    await pool.query(
      `INSERT INTO users (user_id, full_name, primary_class, email, user_role, status, phone_number, password, expiry_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        user_id,
        fullName,
        payroll_class,
        email,
        role,
        userStatus,
        phone,
        password,
        expiryDate || null,
      ],
    );
    res.status(201).json({ message: "✅ User created", user_id });
  } catch (err) {
    console.error("❌ Error creating user:", err);

    // MySQL duplicate entry error code
    if (err.code === "ER_DUP_ENTRY") {
      // Parse which field is duplicated from the error message
      if (err.message.includes("PRIMARY") || err.message.includes("user_id")) {
        return res
          .status(409)
          .json({ error: `User ID "${user_id}" already exists.` });
      }
      if (err.message.includes("email")) {
        return res
          .status(409)
          .json({ error: `Email "${email}" is already registered.` });
      }
      return res
        .status(409)
        .json({ error: "A user with this ID or email already exists." });
    }

    res.status(500).json({ error: err.message || "Database error" });
  }
});

router.put("/:user_id", verifyToken, async (req, res) => {
  const {
    payroll_class,
    full_name,
    email,
    user_role,
    status,
    phone_number,
    password,
    expiry_date,
  } = req.body;
  try {
    if (typeof status !== "undefined") {
      const validStatuses = ["active", "inactive", "suspended"];
      if (!validStatuses.includes(status))
        return res
          .status(400)
          .json({
            error: `Invalid status. Must be one of: ${validStatuses.join(", ")}`,
          });
    }
    if (
      typeof expiry_date !== "undefined" &&
      expiry_date !== null &&
      expiry_date !== ""
    ) {
      const expiry = new Date(expiry_date);
      if (isNaN(expiry.getTime()))
        return res.status(400).json({ error: "Invalid expiry date format" });
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      if (expiry < today)
        return res
          .status(400)
          .json({ error: "Expiry date cannot be in the past" });
    }

    const sets = [],
      params = [];
    if (typeof full_name !== "undefined") {
      sets.push("full_name = ?");
      params.push(full_name);
    }
    if (typeof email !== "undefined") {
      sets.push("email = ?");
      params.push(email);
    }
    if (typeof user_role !== "undefined") {
      sets.push("user_role = ?");
      params.push(user_role);
    }
    if (typeof status !== "undefined") {
      sets.push("status = ?");
      params.push(status);
    }
    if (typeof phone_number !== "undefined") {
      sets.push("phone_number = ?");
      params.push(phone_number);
    }
    if (typeof expiry_date !== "undefined") {
      sets.push("expiry_date = ?");
      params.push(expiry_date === "" ? null : expiry_date);
    }
    if (typeof payroll_class !== "undefined") {
      sets.push("primary_class = ?");
      params.push(payroll_class);
    }
    if (typeof password !== "undefined" && password !== "") {
      sets.push("password = ?");
      params.push(password);
    }

    if (!sets.length)
      return res.status(400).json({ error: "No updatable fields provided" });

    params.push(req.params.user_id);
    const [result] = await pool.query(
      `UPDATE users SET ${sets.join(", ")} WHERE user_id = ?`,
      params,
    );
    if (result.affectedRows === 0)
      return res.status(404).json({ error: "User not found" });

    const [rows] = await pool.query("SELECT * FROM users WHERE user_id = ?", [
      req.params.user_id,
    ]);
    res.json({ message: "User updated", user: rows[0] });
  } catch (err) {
    console.error("❌ Error updating user:", err);
    res.status(500).json({ error: "Database error" });
  }
});

router.delete("/:user_id", verifyToken, async (req, res) => {
  try {
    const [result] = await pool.query("DELETE FROM users WHERE user_id = ?", [
      req.params.user_id,
    ]);
    if (result.affectedRows === 0)
      return res.status(404).json({ error: "User not found" });
    res.json({ message: "✅ User deleted", user_id: req.params.user_id });
  } catch (err) {
    console.error("❌ Error deleting user:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// ============================================================
// FORGOT PASSWORD — helpers
// ============================================================

async function findUserCandidates(user_id, databasesToSearch) {
  const candidates = [];
  for (const dbName of databasesToSearch) {
    if (!dbName) continue;
    try {
      pool.useDatabase(dbName);
      const [rows] = await pool.query("SELECT * FROM users WHERE user_id = ?", [
        user_id,
      ]);
      if (rows.length) {
        candidates.push({ user: rows[0], database: dbName });
        console.log(`✅ Found ${user_id} in ${dbName}`);
      }
    } catch (err) {
      console.log(`❌ Error searching ${dbName}:`, err.message);
    }
  }
  return candidates;
}

function checkIdentityMatch(
  user,
  full_name,
  email,
  primary_class,
  dbToClass,
  classToDb,
) {
  const nameOk =
    user.full_name?.toLowerCase().trim() === full_name.toLowerCase().trim();
  const emailOk =
    user.email?.toLowerCase().trim() === email.toLowerCase().trim();
  let classOk = true;
  if (primary_class) {
    const userDb = resolveToDbName(user.primary_class, dbToClass, classToDb);
    const providedDb =
      resolveToDbName(primary_class, dbToClass, classToDb) || primary_class;
    classOk = userDb === providedDb;
  }
  return { nameOk, emailOk, classOk, ok: nameOk && emailOk && classOk };
}

function identityErrorMsg(
  candidates,
  full_name,
  email,
  primary_class,
  dbToClass,
  classToDb,
) {
  const wrong = new Set();
  for (const { user } of candidates) {
    const { nameOk, emailOk, classOk } = checkIdentityMatch(
      user,
      full_name,
      email,
      primary_class,
      dbToClass,
      classToDb,
    );
    if (!nameOk) wrong.add("Full Name");
    if (!emailOk) wrong.add("Email");
    if (!classOk) wrong.add("Payroll Class");
  }
  const list = [...wrong];
  return (
    "Identity verification failed. " +
    (list.length
      ? `Incorrect: ${list.join(", ")}. Please check and try again.`
      : "Please check your information and try again.")
  );
}

router.post("/verify-identity", async (req, res) => {
  const { user_id, full_name, email, primary_class } = req.body;
  try {
    if (!user_id || !full_name || !email)
      return res
        .status(400)
        .json({
          error: "User ID, Full Name, and Email are required for verification",
        });

    const { databasesToSearch, dbToClass, classToDb } =
      await loadPayrollMapping();
    const candidates = await findUserCandidates(user_id, databasesToSearch);

    if (!candidates.length)
      return res
        .status(404)
        .json({ error: "User not found. Please check your User ID." });

    let verifiedUser = null,
      verifiedDatabase = null;
    for (const { user, database } of candidates) {
      if (
        checkIdentityMatch(
          user,
          full_name,
          email,
          primary_class,
          dbToClass,
          classToDb,
        ).ok
      ) {
        verifiedUser = user;
        verifiedDatabase = database;
        break;
      }
    }

    if (!verifiedUser)
      return res
        .status(401)
        .json({
          error: identityErrorMsg(
            candidates,
            full_name,
            email,
            primary_class,
            dbToClass,
            classToDb,
          ),
        });

    if (verifiedUser.status !== "active")
      return res
        .status(403)
        .json({
          error: "Account is not active. Please contact administrator.",
        });

    res.json({
      message: "Identity verified successfully",
      user: {
        user_id: verifiedUser.user_id,
        full_name: verifiedUser.full_name,
        email: verifiedUser.email,
        primary_class: verifiedUser.primary_class,
        database: verifiedDatabase,
      },
    });
  } catch (err) {
    console.error("❌ Identity verification error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

router.post("/reset-password", async (req, res) => {
  const { user_id, full_name, email, new_password, primary_class } = req.body;
  try {
    if (!user_id || !full_name || !email || !new_password)
      return res.status(400).json({ error: "All fields are required" });
    if (new_password.length < 6)
      return res
        .status(400)
        .json({ error: "Password must be at least 6 characters long" });

    const { databasesToSearch, dbToClass, classToDb } =
      await loadPayrollMapping();
    const candidates = await findUserCandidates(user_id, databasesToSearch);

    if (!candidates.length)
      return res.status(404).json({ error: "User not found" });

    let verifiedUser = null,
      verifiedDatabase = null;
    for (const { user, database } of candidates) {
      if (
        checkIdentityMatch(
          user,
          full_name,
          email,
          primary_class,
          dbToClass,
          classToDb,
        ).ok
      ) {
        verifiedUser = user;
        verifiedDatabase = database;
        break;
      }
    }

    if (!verifiedUser)
      return res
        .status(401)
        .json({
          error: identityErrorMsg(
            candidates,
            full_name,
            email,
            primary_class,
            dbToClass,
            classToDb,
          ),
        });

    pool.useDatabase(verifiedDatabase);
    const [result] = await pool.query(
      "UPDATE users SET password = ? WHERE user_id = ?",
      [new_password, user_id],
    );

    if (result.affectedRows === 0)
      return res.status(500).json({ error: "Failed to update password" });

    console.log(`✅ Password reset for ${user_id} in ${verifiedDatabase}`);
    res.json({ message: "✅ Password reset successfully", user_id });
  } catch (err) {
    console.error("❌ Password reset error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
