import B2 from "backblaze-b2";
import sharp from "sharp";
import Room from '../models/RoomSchema.js';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';
dotenv.config();

// Initialize B2 client
const b2 = new B2({
  applicationKeyId: process.env.B2_APP_KEY_ID,
  applicationKey: process.env.B2_APP_KEY,
});

const BUCKET_ID = process.env.B2_BUCKET_ID;
const BUCKET_NAME = process.env.B2_BUCKET_NAME;
const CDN_URL = process.env.CDN_URL;

// Validate environment variables
if (!BUCKET_ID || !BUCKET_NAME || !process.env.B2_APP_KEY_ID || !process.env.B2_APP_KEY || !CDN_URL) {
  throw new Error("Missing required B2 environment variables!");
}

// 🔐 B2 Authorization Cache (reuse for 23 hours)
let b2Authorized = false;
let b2AuthExpiry = null;

async function ensureB2Authorized() {
  if (b2Authorized && b2AuthExpiry && Date.now() < b2AuthExpiry) {
    return;
  }

  await b2.authorize();
  b2Authorized = true;
  b2AuthExpiry = Date.now() + (23 * 60 * 60 * 1000);
  console.log('✅ B2 authorized');
}

// ⚡ GET FRESH UPLOAD URL (for each parallel upload)
async function getUploadUrl() {
  await ensureB2Authorized();

  const uploadUrlResponse = await b2.getUploadUrl({
    bucketId: BUCKET_ID,
  });

  return {
    authToken: uploadUrlResponse.data.authorizationToken,
    uploadUrl: uploadUrlResponse.data.uploadUrl
  };
}

// 📤 Upload to B2 Helper (gets fresh URL each time)
async function uploadToB2(buffer, fileName, contentType = "image/jpeg") {
  const { authToken, uploadUrl } = await getUploadUrl();

  const response = await b2.uploadFile({
    uploadUrl: uploadUrl,
    uploadAuthToken: authToken,
    fileName: fileName,
    data: buffer,
    mime: contentType,
    // ⚡ CACHE OPTIMIZATION: Aggressive caching for CDN
    info: {
      'Cache-Control': 'public, max-age=31536000, immutable'
    }
  });

  return `${CDN_URL}/${fileName}`;
}

// 🗑️ Delete from B2 Helper
async function deleteFromB2(fileUrl) {
  try {
    if (fileUrl.includes('s3.amazonaws.com') || fileUrl.includes('.s3.')) {
      console.log(`⚠️ Skipping S3 URL: ${fileUrl}`);
      return;
    }

    if (!fileUrl.includes(CDN_URL)) {
      console.log(`⚠️ Skipping non-B2 URL: ${fileUrl}`);
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
      console.log(`✅ Deleted: ${fileName}`);
    }
  } catch (error) {
    console.error(`❌ Delete error:`, error.message);
  }
}

// 🗑️ Batch delete helper
async function safelyDeleteImagesFromB2(imagesToDelete, roomId) {
  console.log(`🗑️ Deleting ${imagesToDelete.length} images for room ${roomId}`);

  // ⚡ DELETE IN PARALLEL
  await Promise.all(
    imagesToDelete.map(img => img.originalUrl ? deleteFromB2(img.originalUrl) : Promise.resolve())
  );
}

// ⚡ OPTIMIZED: Process single image (NO WATERMARK)
async function processImage(fileBuffer, timestamp, index) {
  const mainBuffer = await sharp(fileBuffer)
    .resize({
      width: 1280,
      withoutEnlargement: true,
      fit: 'inside'
    })
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer();

  const mainKey = `properties/${uuidv4()}-${timestamp}-${index}.jpg`;
  const mainUrl = await uploadToB2(mainBuffer, mainKey, "image/jpeg");

  return mainUrl;
}

// ⚡ OPTIMIZED: Process thumbnail (ONLY for first image)
async function processThumbnail(fileBuffer, timestamp) {
  const thumbBuffer = await sharp(fileBuffer)
    .resize({
      width: 800,
      withoutEnlargement: true,
      fit: 'inside'
    })
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();

  const thumbKey = `properties/thumbs/${uuidv4()}-${timestamp}-thumb.jpg`;
  const thumbUrl = await uploadToB2(thumbBuffer, thumbKey, "image/jpeg");

  return thumbUrl;
}

// ⚡⚡⚡ ULTRA-FAST UPLOAD - Parallel Processing with Fresh Upload URLs
export const uploadRooms = async (req, res) => {
  try {
    const timestamp = Date.now();

    // 1️⃣ Collect files
    let allFiles = [];
    if (req.files) {
      if (req.files.images && Array.isArray(req.files.images)) {
        allFiles = [...allFiles, ...req.files.images];
      }
      if (Array.isArray(req.files)) {
        allFiles = req.files;
      }
      if (allFiles.length === 0) {
        for (const [key, value] of Object.entries(req.files)) {
          if (Array.isArray(value)) {
            allFiles = [...allFiles, ...value];
          }
        }
      }
    }

    if (allFiles.length === 0) {
      return res.status(400).json({ success: false, message: "No files uploaded" });
    }

    console.log(`📸 Processing ${allFiles.length} images...`);

    // ⚡ 2️⃣ PROCESS ALL IMAGES IN PARALLEL (each gets its own upload URL)
    const imagePromises = allFiles.map((file, index) => {
      if (!file.buffer || file.buffer.length === 0) return null;
      return processImage(file.buffer, timestamp, index);
    });

    // ⚡ 3️⃣ PROCESS THUMBNAIL (only first image)
    const thumbnailPromise = allFiles[0]?.buffer
      ? processThumbnail(allFiles[0].buffer, timestamp)
      : null;

    // ⚡ 4️⃣ WAIT FOR ALL UPLOADS TO COMPLETE (parallel - each with fresh token)
    const [imageUrls, thumbnailUrl] = await Promise.all([
      Promise.all(imagePromises),
      thumbnailPromise
    ]);

    // 5️⃣ Filter out null values and format
    const images = imageUrls
      .filter(url => url !== null)
      .map(url => ({ originalUrl: url }));

    const thumbnail = thumbnailUrl ? { url: thumbnailUrl } : null;

    if (images.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No images processed successfully",
      });
    }

    console.log(`✅ ${images.length} images uploaded successfully`);

    // 6️⃣ Parse location
    let parsedLocation;
    if (req.body.location) {
      try {
        let locationValue = Array.isArray(req.body.location)
          ? req.body.location[req.body.location.length - 1]
          : req.body.location;
        parsedLocation = typeof locationValue === "string"
          ? JSON.parse(locationValue)
          : locationValue;
      } catch {
        parsedLocation = null;
      }
    }

    // Helper functions
    const parseJSON = (field) => {
      if (!req.body[field]) return undefined;
      try {
        let value = Array.isArray(req.body[field])
          ? req.body[field][req.body[field].length - 1]
          : req.body[field];
        return JSON.parse(value);
      } catch {
        return Array.isArray(req.body[field])
          ? req.body[field][req.body[field].length - 1]
          : req.body[field];
      }
    };

    const getValue = (field) => {
      const value = req.body[field];
      return Array.isArray(value) ? value[value.length - 1] : value;
    };

    // Auto-set expiry date
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + 30);

    // 7️⃣ Create room document
    const roomData = {
      category: getValue("category") || null,
      title: getValue("title") || "",
      description: getValue("description") || "",
      images,
      thumbnail,
      location: parsedLocation || null,
      contactPhone: getValue("contactPhone") || "",
      showPhonePublic: getValue("showPhonePublic") === "true",
      monthlyRent: getValue("monthlyRent") || null,
      priceRange: parseJSON("priceRange") || {},
      securityDeposit: getValue("securityDeposit") || null,
      roommatesWanted: getValue("roommatesWanted") || null,
      genderPreference: getValue("genderPreference") || null,
      habitPreferences: parseJSON("habitPreferences") || [],
      purpose: parseJSON("purpose") || [],
      availableSpace: getValue("availableSpace") || null,
      pgGenderCategory: getValue("pgGenderCategory") || null,
      roomTypesAvailable: parseJSON("roomTypesAvailable") || [],
      mealsProvided: parseJSON("mealsProvided") || [],
      amenities: parseJSON("amenities") || [],
      rules: parseJSON("rules") || [],
      propertyType: getValue("propertyType") || null,
      furnishedStatus: getValue("furnishedStatus") || null,
      squareFeet: getValue("squareFeet") || null,
      bedrooms: getValue("bedrooms") || null,
      bathrooms: getValue("bathrooms") || null,
      balconies: getValue("balconies") || null,
      floorNumber: getValue("floorNumber") || null,
      totalFloors: getValue("totalFloors") || null,
      tenantPreference: getValue("tenantPreference") || null,
      parking: getValue("parking") || null,
      expiryDate: getValue("expiryDate") || expiryDate,
      createdBy: req.user.id,
    };

    const room = new Room(roomData);
    await room.save();

    res.status(201).json({
      success: true,
      room: {
        ...room.toObject(),
        imageCount: room.images.length,
        hasThumbnail: !!room.thumbnail,
      },
    });

  } catch (err) {
    console.error("❌ Create Room Error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to create room",
      error: err.message,
    });
  }
};

// ⚡⚡⚡ ULTRA-FAST UPDATE - Parallel Processing with Fresh Upload URLs
export const updateRoom = async (req, res) => {
  try {
    const { roomId } = req.params;
    const userId = req.user.id;
    const timestamp = Date.now();

    console.log(`🔄 UPDATE ROOM: User ${userId} → Room ${roomId}`);

    const existingRoom = await Room.findOne({
      _id: roomId,
      createdBy: userId
    });

    if (!existingRoom) {
      return res.status(404).json({
        success: false,
        message: 'Room not found or unauthorized'
      });
    }

    const existingImagesToKeep = req.body.existingImages
      ? JSON.parse(req.body.existingImages)
      : [];

    const imageFiles = req.files && req.files.images
      ? (Array.isArray(req.files.images) ? req.files.images : [req.files.images])
      : [];

    console.log('📸 Image Update:', {
      current: existingRoom.images.length,
      keeping: existingImagesToKeep.length,
      newFiles: imageFiles.length
    });

    // ⚡ DELETE OLD IMAGES IN PARALLEL (background)
    const imagesToDelete = existingRoom.images.filter(existingImg =>
      !existingImagesToKeep.includes(existingImg.originalUrl)
    );

    if (imagesToDelete.length > 0) {
      // console.log('🗑️ Deleting:', imagesToDelete.length);
      safelyDeleteImagesFromB2(imagesToDelete, roomId).catch(err =>
        console.error('Background delete error:', err)
      );
    }

    // Start with existing images
    let images = existingImagesToKeep.map(url => ({ originalUrl: url }));
    let thumbnail = null;

    // ⚡ PROCESS NEW IMAGES IN PARALLEL (each gets fresh upload URL)
    if (imageFiles.length > 0) {
      // console.log('📤 Processing new images:', imageFiles.length);

      const imagePromises = imageFiles.map((file, index) => {
        if (!file.buffer || file.buffer.length === 0) return null;
        return processImage(file.buffer, timestamp, index);
      });

      // ⚡ PROCESS THUMBNAIL (only if first image and no existing images)
      const thumbnailPromise = (imageFiles[0]?.buffer && images.length === 0)
        ? processThumbnail(imageFiles[0].buffer, timestamp)
        : null;

      // ⚡ WAIT FOR ALL UPLOADS
      const [newImageUrls, newThumbnailUrl] = await Promise.all([
        Promise.all(imagePromises),
        thumbnailPromise
      ]);

      // Add new images
      const newImages = newImageUrls
        .filter(url => url !== null)
        .map(url => ({ originalUrl: url }));

      images = [...images, ...newImages];

      if (newThumbnailUrl) {
        thumbnail = { url: newThumbnailUrl };
      }

      // console.log(`✅ ${newImages.length} new images uploaded`);
    }

    // Handle separate thumbnail upload
    if (req.files && req.files.thumbnail && !thumbnail) {
      const thumbFile = Array.isArray(req.files.thumbnail)
        ? req.files.thumbnail[0]
        : req.files.thumbnail;

      const thumbnailUrl = await processThumbnail(thumbFile.buffer, timestamp);
      thumbnail = { url: thumbnailUrl };
    }

    // Set thumbnail from first image if none exists
    if (images.length > 0 && !thumbnail) {
      thumbnail = { url: images[0].originalUrl };
    }

    // Parse helpers
    const parseJSON = (field) => {
      if (!req.body[field]) return undefined;
      try {
        let value = Array.isArray(req.body[field])
          ? req.body[field][req.body[field].length - 1]
          : req.body[field];
        return JSON.parse(value);
      } catch {
        return Array.isArray(req.body[field])
          ? req.body[field][req.body[field].length - 1]
          : req.body[field];
      }
    };

    const getValue = (field) => {
      const value = req.body[field];
      return Array.isArray(value) ? value[value.length - 1] : value;
    };

    let parsedLocation = existingRoom.location;
    if (req.body.location) {
      try {
        let locationValue = Array.isArray(req.body.location)
          ? req.body.location[req.body.location.length - 1]
          : req.body.location;
        parsedLocation = typeof locationValue === "string"
          ? JSON.parse(locationValue)
          : locationValue;
      } catch (error) {
        // console.log('Location parse error, keeping existing');
      }
    }

    // Build update data
    const updateData = {
      category: getValue("category") || existingRoom.category,
      title: getValue("title") || existingRoom.title,
      description: getValue("description") || existingRoom.description,
      images: images.length > 0 ? images : existingRoom.images,
      thumbnail: thumbnail || existingRoom.thumbnail,
      location: parsedLocation,
      contactPhone: getValue("contactPhone") || existingRoom.contactPhone,
      showPhonePublic: getValue("showPhonePublic") === "true" || existingRoom.showPhonePublic,
      monthlyRent: getValue("monthlyRent") || existingRoom.monthlyRent,
      priceRange: parseJSON("priceRange") || existingRoom.priceRange,
      securityDeposit: getValue("securityDeposit") || existingRoom.securityDeposit,
      roommatesWanted: getValue("roommatesWanted") || existingRoom.roommatesWanted,
      genderPreference: getValue("genderPreference") || existingRoom.genderPreference,
      habitPreferences: parseJSON("habitPreferences") || existingRoom.habitPreferences,
      purpose: parseJSON("purpose") || existingRoom.purpose,
      availableSpace: getValue("availableSpace") || existingRoom.availableSpace,
      pgGenderCategory: getValue("pgGenderCategory") || existingRoom.pgGenderCategory,
      roomTypesAvailable: parseJSON("roomTypesAvailable") || existingRoom.roomTypesAvailable,
      mealsProvided: parseJSON("mealsProvided") || existingRoom.mealsProvided,
      amenities: parseJSON("amenities") || existingRoom.amenities,
      rules: parseJSON("rules") || existingRoom.rules,
      propertyType: getValue("propertyType") || existingRoom.propertyType,
      furnishedStatus: getValue("furnishedStatus") || existingRoom.furnishedStatus,
      squareFeet: getValue("squareFeet") || existingRoom.squareFeet,
      bedrooms: getValue("bedrooms") || existingRoom.bedrooms,
      bathrooms: getValue("bathrooms") || existingRoom.bathrooms,
      balconies: getValue("balconies") || existingRoom.balconies,
      floorNumber: getValue("floorNumber") || existingRoom.floorNumber,
      totalFloors: getValue("totalFloors") || existingRoom.totalFloors,
      tenantPreference: getValue("tenantPreference") || existingRoom.tenantPreference,
      parking: getValue("parking") || existingRoom.parking,
      updatedAt: new Date()
    };

    Object.keys(updateData).forEach(key => {
      if (updateData[key] === undefined) {
        delete updateData[key];
      }
    });

    const updatedRoom = await Room.findByIdAndUpdate(
      roomId,
      updateData,
      { new: true, runValidators: true }
    ).populate('createdBy', 'name picture');

    // console.log(`✅ ROOM UPDATED: ${roomId} with ${images.length} images`);

    res.json({
      success: true,
      message: 'Room updated successfully',
      room: {
        ...updatedRoom.toObject(),
        imageCount: updatedRoom.images.length,
        hasThumbnail: !!updatedRoom.thumbnail,
      },
    });

  } catch (error) {
    console.error("❌ Update Room Error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update room",
      error: error.message,
    });
  }
};

// Keep filter functions unchanged
function buildFilterQuery(filterData, category) {
  const query = {};

  Object.keys(filterData).forEach(key => {
    const filter = filterData[key];
    if (!filter.selected) return;

    let filterQuery = null;

    if (category === 'shared') {
      filterQuery = buildSharedFilter(key, filter);
    } else if (category === 'pg_hostel') {
      filterQuery = buildPgFilter(key, filter);
    } else if (category === 'flat_home') {
      filterQuery = buildRentalFilter(key, filter);
    }

    if (filterQuery) {
      query[key] = filterQuery;
    }
  });

  return query;
}

function buildSharedFilter(key, filter) {
  switch (key) {
    case 'monthlyRent':
    case 'roommatesWanted':
      return {
        $gte: filter.currentMin || filter.min,
        $lte: filter.currentMax || filter.max
      };
    case 'genderPreference':
    case 'habitPreferences':
    case 'purpose':
      if (filter.options && Array.isArray(filter.options)) {
        const selectedOptions = filter.options
          .filter(opt => opt.selected)
          .map(opt => opt.value);
        return selectedOptions.length > 0 ? { $in: selectedOptions } : null;
      }
      return null;
    case 'showPhonePublic':
      return filter.value === true;
    default:
      return null;
  }
}

function buildPgFilter(key, filter) {
  switch (key) {
    case 'priceRange':
      return {
        'priceRange.min': { $lte: filter.currentMax || filter.max },
        'priceRange.max': { $gte: filter.currentMin || filter.min }
      };

    case 'pgGenderCategory':
    case 'roomTypesAvailable':
    case 'mealsProvided':
    case 'amenities':
    case 'rules':
      if (filter.options && Array.isArray(filter.options)) {
        const selectedOptions = filter.options
          .filter(opt => opt.selected)
          .map(opt => opt.value);
        return selectedOptions.length > 0 ? { $in: selectedOptions } : null;
      }
      return null;
    default:
      return null;
  }
}

function buildRentalFilter(key, filter) {
  switch (key) {
    case 'monthlyRent':
    case 'securityDeposit':
    case 'squareFeet':
    case 'bedrooms':
    case 'bathrooms':
      return {
        $gte: filter.currentMin || filter.min,
        $lte: filter.currentMax || filter.max
      };
    case 'propertyType':
    case 'furnishedStatus':
    case 'tenantPreference':
    case 'parking':
      if (filter.options && Array.isArray(filter.options)) {
        const selectedOptions = filter.options
          .filter(opt => opt.selected)
          .map(opt => opt.value);
        return selectedOptions.length > 0 ? { $in: selectedOptions } : null;
      }
      return null;
    default:
      return null;
  }
}


// controllers/roomController.js
export const getRooms = async (req, res) => {
  try {
    const {
      category,
      lat,
      lng,
      limit = 15,
      skip = 0,
      filters
    } = req.query;

    // Validate required params
    if (!lat || !lng) {
      return res.status(400).json({
        success: false,
        message: "Location coordinates required"
      });
    }

    const latNum = parseFloat(lat);
    const lngNum = parseFloat(lng);

    // Validate coordinates
    if (isNaN(latNum) || isNaN(lngNum)) {
      return res.status(400).json({
        success: false,
        message: "Invalid coordinates"
      });
    }

    const limitNum = Math.min(parseInt(limit) || 15, 50); // Max 50 per request
    const skipNum = Math.max(parseInt(skip) || 0, 0);

    // Build optimized query for $geoNear
    const geoNearQuery = {
      // Exclude deleted rooms
      $or: [
        { isDeleted: { $exists: false } },
        { isDeleted: false }
      ],
      // Exclude blocked rooms  
      $and: [
        {
          $or: [
            { isBlocked: { $exists: false } },
            { isBlocked: false }
          ]
        },
        // Only active rooms
        {
          $or: [
            { isActive: { $exists: false } },
            { isActive: true }
          ]
        },
        // Not expired (SKIP expiry check for PG/Hostel)
        {
          $or: [
            { expiryDate: { $exists: false } },
            { expiryDate: { $gt: new Date() } },
            { category: 'pg_hostel' } // PG/Hostel posts never expire
          ]
        }
      ]
    };

    // Add category filter if specified
    if (category && category !== 'all') {
      geoNearQuery.category = category;
    }

    // Parse and add custom filters
    if (filters && filters !== '{}') {
      try {
        const filterData = JSON.parse(filters);
        const filterQuery = buildFilterQuery(filterData, category);

        if (Object.keys(filterQuery).length > 0) {
          // Merge filter conditions into $and array
          if (filterQuery.$and) {
            geoNearQuery.$and = [...geoNearQuery.$and, ...filterQuery.$and];
          } else {
            Object.assign(geoNearQuery, filterQuery);
          }
        }
      } catch (parseError) {
        console.error("Filter parsing error:", parseError);
        return res.status(400).json({
          success: false,
          message: "Invalid filter format"
        });
      }
    }

    // Optimized aggregation pipeline
    const aggregationPipeline = [
      {
        $geoNear: {
          near: {
            type: "Point",
            coordinates: [lngNum, latNum]
          },
          distanceField: "distance",
          spherical: true,
          distanceMultiplier: 0.001, // km
          query: geoNearQuery,
          maxDistance: 45000, // 45km radius
        }
      },
      {
        $sort: {
          distance: 1,
          createdAt: -1
        }
      },
      { $skip: skipNum },
      { $limit: limitNum },
      // ✅ Project ALL needed fields for cards
      {
        $project: {
          // Common fields
          title: 1,
          description: 1,
          category: 1,
          thumbnail: 1,
          images: 1,
          location: 1,
          distance: 1,
          createdAt: 1,

          // Financial
          monthlyRent: 1,
          priceRange: 1,
          securityDeposit: 1,

          // Shared Room fields
          roommatesWanted: 1,
          genderPreference: 1,
          habitPreferences: 1,

          // PG/Hostel fields
          availableSpace: 1,
          pgGenderCategory: 1,
          roomTypesAvailable: 1,
          mealsProvided: 1,
          amenities: 1,
          rules: 1,

          // Flat/Home fields
          propertyType: 1,
          furnishedStatus: 1,
          bedrooms: 1,
          bathrooms: 1,
          balconies: 1,
          squareFeet: 1,
          floorNumber: 1,
          totalFloors: 1,
          tenantPreference: 1,
          parking: 1,

          // Engagement
          views: 1,
          likes: 1,
          favorites: 1,

          // Owner info
          createdBy: 1
        }
      }
    ];

    // console.log('🔍 Query:', JSON.stringify({ category, skipNum, limitNum }));

    const rooms = await Room.aggregate(aggregationPipeline);

    // Calculate distance info efficiently
    const roomsWithDistance = rooms.map(room => {
      const straightLineKm = room.distance;
      const roadDistanceKm = straightLineKm * 1.4; // Approximate

      let distance, label;

      if (roadDistanceKm < 1) {
        distance = Math.round(roadDistanceKm * 1000);
        label = `${distance} m`;
      } else {
        distance = Math.round(roadDistanceKm * 10) / 10; // 1 decimal
        label = `${distance} km`;
      }

      return {
        ...room,
        approximateRoadDistance: roadDistanceKm < 1
          ? Math.round(roadDistanceKm * 1000)
          : Math.round(roadDistanceKm),
        individualDistance: label,
        distanceLabel: `${label} away`
      };
    });

    res.json({
      success: true,
      rooms: roomsWithDistance,
      count: rooms.length,
      hasMore: rooms.length === limitNum,
      pagination: {
        skip: skipNum,
        limit: limitNum,
        returned: rooms.length
      }
    });

  } catch (err) {
    console.error("❌ Get Rooms Error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to fetch rooms",
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
};

// Helper function to build filter queries based on category


// GET /api/rooms/:id
export const getRoomById = async (req, res) => {
  // console.log("inside single room controller");

  try {
    const { id } = req.params;
    const room = await Room.findById(id).populate("createdBy", "name picture");


    if (!room) {
      return res.status(404).json({ success: false, message: "Room not found" });
    }
    // console.log(room, "roomdata");

    res.json({ success: true, room });
  } catch (err) {
    console.error("Get Room Error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch room" });
  }
};


export const incrementRoomView = async (req, res) => {
  // console.log("Increment Room View Controller Hit");

  try {
    const { roomId } = req.params; // roomId from URL params
    const { userId } = req.body;   // userId from request body

    const room = await Room.findById(roomId);

    if (!room) {
      return res.status(404).json({ success: false, message: "Room not found" });
    }

    // ✅ Only increment if user hasn't viewed before
    if (userId && !room.viewedBy.includes(userId)) {
      room.views += 1;
      room.viewedBy.push(userId);
      await room.save();
    }

    // ✅ If user is not logged in, you can still increment view (optional)
    if (!userId) {
      room.views += 1;
      await room.save();
    }

    res.status(200).json({
      success: true,
      message: "View count updated",
      views: room.views,
    });
  } catch (error) {
    console.error("❌ Error incrementing room view:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

export const addFavorite = async (req, res) => {
  try {
    const { roomId } = req.body;
    const userId = req.user._id;

    // console.log(`❤️ ADD FAVORITE: User ${userId} → Room ${roomId}`);

    // Validation
    if (!roomId) {
      return res.status(400).json({
        success: false,
        message: 'Room ID is required'
      });
    }

    // Check if room exists
    const room = await Room.findById(roomId);
    if (!room) {
      return res.status(404).json({
        success: false,
        message: 'Room not found'
      });
    }

    // Check if already favorited
    if (room.favorites.includes(userId)) {
      return res.status(400).json({
        success: false,
        message: 'Room already in favorites'
      });
    }

    // Add user to favorites array
    room.favorites.push(userId);
    await room.save();

    // console.log(`✅ FAVORITE ADDED to room: ${roomId}`);

    res.status(201).json({
      success: true,
      message: 'Room added to favorites successfully',
      roomId: roomId,
      isFavorited: true
    });

  } catch (error) {
    console.error('❌ Error adding favorite:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to add favorite',
      error: error.message
    });
  }
};

// ✅ REMOVE FROM FAVORITES
export const removeFavorite = async (req, res) => {
  try {
    const { roomId } = req.body;
    const userId = req.user._id;

    // console.log(`🗑️ REMOVE FAVORITE: User ${userId} → Room ${roomId}`);

    // Validation
    if (!roomId) {
      return res.status(400).json({
        success: false,
        message: 'Room ID is required'
      });
    }

    const room = await Room.findById(roomId);
    if (!room) {
      return res.status(404).json({
        success: false,
        message: 'Room not found'
      });
    }

    // Check if actually favorited
    if (!room.favorites.includes(userId)) {
      return res.status(404).json({
        success: false,
        message: 'Room not in favorites'
      });
    }

    // Remove user from favorites array
    room.favorites = room.favorites.filter(favId => !favId.equals(userId));
    await room.save();

    // console.log(`✅ FAVORITE REMOVED from room: ${roomId}`);

    res.json({
      success: true,
      message: 'Room removed from favorites successfully',
      roomId: roomId,
      isFavorited: false
    });

  } catch (error) {
    console.error('❌ Error removing favorite:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to remove favorite',
      error: error.message
    });
  }
};

// ✅ TOGGLE FAVORITE (Add/Remove in one endpoint)
export const toggleFavorite = async (req, res) => {
  try {
    const { roomId } = req.body;
    const userId = req.user._id;

    // console.log(`🔄 TOGGLE FAVORITE: User ${userId} → Room ${roomId}`);

    if (!roomId) {
      return res.status(400).json({
        success: false,
        message: 'Room ID is required'
      });
    }

    // Check if room exists
    const room = await Room.findById(roomId);
    if (!room) {
      return res.status(404).json({
        success: false,
        message: 'Room not found'
      });
    }

    const isCurrentlyFavorited = room.favorites.includes(userId);
    let action = '';

    if (isCurrentlyFavorited) {
      // Remove from favorites
      room.favorites = room.favorites.filter(favId => !favId.equals(userId));
      action = 'removed';
      // console.log(`✅ FAVORITE REMOVED: ${roomId}`);
    } else {
      // Add to favorites
      room.favorites.push(userId);
      action = 'added';
      // console.log(`✅ FAVORITE ADDED: ${roomId}`);
    }

    await room.save();

    res.json({
      success: true,
      message: `Room ${action} from favorites successfully`,
      isFavorited: !isCurrentlyFavorited,
      roomId: roomId
    });

  } catch (error) {
    console.error('❌ Error toggling favorite:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to toggle favorite',
      error: error.message
    });
  }
};

// ✅ GET USER'S FAVORITES
export const getMyFavorites = async (req, res) => {
  try {
    const userId = req.user._id;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    // console.log(`📚 GET FAVORITES: User ${userId} - Page ${page}`);

    // Find rooms where user ID is in favorites array
    const favoriteRooms = await Room.find({
      favorites: userId,
      isActive: true,
      isBlocked: false
    })
      .populate('createdBy', 'name picture')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await Room.countDocuments({
      favorites: userId,
      isActive: true,
      isBlocked: false
    });

    // console.log(`✅ FAVORITES FETCHED: ${favoriteRooms.length} rooms`);

    res.json({
      success: true,
      favorites: favoriteRooms,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });

  } catch (error) {
    console.error('❌ Error fetching favorites:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch favorites',
      error: error.message
    });
  }
};

// ✅ CHECK IF ROOM IS FAVORITED
export const checkFavorite = async (req, res) => {
  // console.log("fghjjjjjjjjjjjjj--------");


  try {
    const { roomId } = req.params;
    const userId = req.user._id;

    // console.log(`🔍 CHECK FAVORITE: User ${userId} → Room ${roomId}`);

    const room = await Room.findOne({
      _id: roomId,
      favorites: userId
    });

    const isFavorited = !!room;

    console.log(`✅ FAVORITE STATUS: ${isFavorited}`);

    res.json({
      success: true,
      isFavorited
    });

  } catch (error) {
    console.error('❌ Error checking favorite:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to check favorite status',
      error: error.message
    });
  }
};

// ✅ GET FAVORITE COUNT FOR A ROOM
export const getFavoriteCount = async (req, res) => {
  try {
    const { roomId } = req.params;

    const room = await Room.findById(roomId);
    if (!room) {
      return res.status(404).json({
        success: false,
        message: 'Room not found'
      });
    }

    const count = room.favorites.length;

    res.json({
      success: true,
      count,
      roomId
    });

  } catch (error) {
    console.error('❌ Error counting favorites:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get favorite count',
      error: error.message
    });
  }
};