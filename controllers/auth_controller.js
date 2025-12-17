import { OAuth2Client } from "google-auth-library";
import User from "../models/userModal.js";
import jwt from "jsonwebtoken";
import sharp from "sharp";
import { v4 as uuidv4 } from "uuid";
import B2 from "backblaze-b2";

import dotenv from "dotenv";
dotenv.config();
const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

export const googleLogin = async (req, res) => {
  try {
    const { idToken } = req.body;

    const ticket = await client.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const { sub, email, name, picture } = ticket.getPayload();

    let user = await User.findOne({ googleId: sub });

    if (!user) {
      user = await User.create({
        authType: "google",
        googleId: sub,
        email,
        name,
        picture,
        location: null,
      });
    }

    // Generate tokens
    const accessToken = jwt.sign(
      { id: user._id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: "15m" }
    );

    const refreshToken = jwt.sign(
      { id: user._id },
      process.env.JWT_REFRESH_SECRET
    );

    // Store refresh token server-side
    user.refreshToken = refreshToken;
    await user.save();

    res.json({ success: true, accessToken, user }); // only send accessToken to frontend
  } catch (err) {
    console.error(err);
    res.status(400).json({ success: false, message: "Google login failed" });
  }
};

export const updateLocation = async (req, res) => {
  console.log("lkkkkkk");

  try {


    const { userId, location } = req.body;
    // console.log(userId, "userid");
    // console.log(location, "location");


    const user = await User.findByIdAndUpdate(
      userId,
      { location },
      { new: true }
    );

    res.json({ success: true, user });
  } catch (err) {
    console.error(err);
    res.status(400).json({ success: false, message: "Location update failed" });
  }
};






// Initialize B2
const b2 = new B2({
  applicationKeyId: process.env.B2_APP_KEY_ID,
  applicationKey: process.env.B2_APP_KEY,
});

const BUCKET_ID = process.env.B2_BUCKET_ID;
const CDN_URL = process.env.CDN_URL;

let authToken = null;
let uploadUrl = null;
let uploadAuthToken = null;

async function ensureB2Authorized() {
  if (!authToken) {
    const authResponse = await b2.authorize();
    authToken = authResponse.data.authorizationToken;
  }
  return authToken;
}

async function getUploadUrl() {
  await ensureB2Authorized();
  const response = await b2.getUploadUrl({ bucketId: BUCKET_ID });
  uploadUrl = response.data.uploadUrl;
  uploadAuthToken = response.data.authorizationToken;
}

async function uploadToB2(buffer, fileName, contentType) {
  try {
    await getUploadUrl();

    const uploadResponse = await b2.uploadFile({
      uploadUrl,
      uploadAuthToken,
      fileName,
      data: buffer,
      mime: contentType,
      // ⚡ CACHE OPTIMIZATION: Aggressive caching for CDN
      info: {
        'Cache-Control': 'public, max-age=31536000, immutable'
      }
    });

    const fileUrl = `${CDN_URL}/${fileName}`;
    // console.log(`✅ Uploaded: ${fileUrl}`);
    return fileUrl;
  } catch (error) {
    console.error("❌ B2 Upload Error:", error.message);
    throw error;
  }
}

async function deleteFromB2(fileUrl) {
  try {
    if (!fileUrl || !fileUrl.includes(CDN_URL)) {
      // console.log(`⚠️ Skipping non-B2 URL: ${fileUrl}`);
      return;
    }

    const fileName = fileUrl.replace(`${CDN_URL}/`, '').split('?')[0];
    await ensureB2Authorized();

    const fileList = await b2.listFileNames({
      bucketId: BUCKET_ID,
      maxFileCount: 1,
      prefix: fileName,
    });

    if (fileList.data.files.length > 0) {
      const fileId = fileList.data.files[0].fileId;
      await b2.deleteFileVersion({ fileId, fileName });
      // console.log(`✅ Deleted old profile image: ${fileName}`);
    }
  } catch (error) {
    console.error(`❌ Delete error:`, error.message);
  }
}

async function processProfileImage(fileBuffer, timestamp) {
  const processedBuffer = await sharp(fileBuffer)
    .resize({
      width: 800,
      height: 800,
      fit: 'cover',
      position: 'center'
    })
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();

  const fileName = `profiles/${uuidv4()}-${timestamp}.jpg`;
  const fileUrl = await uploadToB2(processedBuffer, fileName, "image/jpeg");

  return fileUrl;
}

// ✅ UPDATE PROFILE
export const updateProfile = async (req, res) => {
  try {
    const userId = req.user.id;
    const { name, about, userRole } = req.body;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const updateData = {};

    if (name && name.trim()) {
      updateData.name = name.trim();
    }

    if (about !== undefined) {
      updateData.about = about.trim();
    }

    if (userRole !== undefined) {
      updateData.userRole = userRole.trim();
    }

    // Handle profile image upload
    if (req.file) {
      const file = req.file;

      if (file.buffer && file.buffer.length > 0) {
        console.log(`📸 Processing profile image...`);

        const timestamp = Date.now();
        const newImageUrl = await processProfileImage(file.buffer, timestamp);

        // Delete old profile image if exists (not Google profile pics)
        if (user.picture && user.picture.includes(CDN_URL)) {
          await deleteFromB2(user.picture);
        }

        updateData.picture = newImageUrl;
        // console.log(`✅ Profile image uploaded: ${newImageUrl}`);
      }
    }

    const updatedUser = await User.findByIdAndUpdate(
      userId,
      { $set: updateData },
      { new: true, runValidators: true }
    ).select('-refreshToken');

    res.status(200).json({
      success: true,
      message: "Profile updated successfully",
      user: updatedUser,
    });

  } catch (error) {
    console.error("❌ Update Profile Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update profile",
      error: error.message,
    });
  }
};

// ✅ GET USER PROFILE
export const getUserProfile = async (req, res) => {
  try {
    const userId = req.user.id;

    const user = await User.findById(userId).select('-refreshToken');

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    res.status(200).json({
      success: true,
      user,
    });

  } catch (error) {
    console.error("❌ Get Profile Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to get profile",
      error: error.message,
    });
  }
};