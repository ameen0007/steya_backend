// middlewares/authMiddleware.js
import jwt from "jsonwebtoken";
import User from "../models/userModal.js";

export const authMiddleware = async (req, res, next) => {
  // console.log("llllll");

  try {
    const authHeader = req.headers["authorization"];
    // console.log("authHeader:", authHeader);

    if (!authHeader) return res.status(401).json({ success: false, message: "No token" });

    const token = authHeader.split(" ")[1];
    // console.log("token:", token);

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    // console.log("decoded:", decoded);

    const user = await User.findById(decoded.id).select("-refreshToken");
    // console.log("user from middleware:", user);

    if (!user) return res.status(401).json({ success: false, message: "User not found" });

    req.user = user;
    next();
  } catch (err) {
    console.error("Middleware error:", err);
    return res.status(401).json({ success: false, message: "Invalid token" });
  }
};
