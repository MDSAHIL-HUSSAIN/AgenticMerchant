import addOnSandboxSdk from "add-on-sdk-document-sandbox";
import { constants, editor } from "express-document-sdk";

const { runtime } = addOnSandboxSdk.instance;
const SIZE = 1080;

function hexToColor(value, opacity) {
  let hex = typeof value === "string" ? value.replace("#", "") : "000000";
  if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  if (hex.length !== 6) hex = "000000";
  return {
    red: parseInt(hex.substring(0, 2), 16) / 255,
    green: parseInt(hex.substring(2, 4), 16) / 255,
    blue: parseInt(hex.substring(4, 6), 16) / 255,
    alpha: opacity === undefined ? 1 : opacity
  };
}

function errorMessage(error) {
  if (error && typeof error.message === "string") return error.message;
  return String(error);
}

function stageError(stage, error) {
  return new Error(`Adobe renderer failed at ${stage}: ${errorMessage(error)}`);
}

function addRect(parent, x, y, width, height, color, opacity = 1) {
  const node = editor.createRectangle();
  node.width = width;
  node.height = height;
  node.translation = { x, y };
  node.fill = editor.makeColorFill(hexToColor(color, opacity));
  parent.children.append(node);
  return node;
}

function addEllipse(parent, x, y, rx, ry, color, opacity = 1) {
  const node = editor.createEllipse();
  node.rx = rx;
  node.ry = ry;
  node.translation = { x, y };
  node.fill = editor.makeColorFill(hexToColor(color, opacity));
  parent.children.append(node);
  return node;
}

function addText(parent, content, x, y, width, size, color, letterSpacing = 0) {
  const node = editor.createText(String(content || ""));
  node.fullContent.applyCharacterStyles({
    fontSize: size,
    color: hexToColor(color, 1),
    letterSpacing
  });
  node.layout = { type: constants.TextLayout.autoHeight, width };
  parent.children.append(node);
  node.setPositionInParent({ x, y }, node.topLeftLocal);
  return node;
}

function addDecoration(parent, design, index) {
  const motif = design.motif || "none";
  if (motif === "contour") {
    addEllipse(parent, 765, 85, 220, 220, design.accent, 0.1);
    addEllipse(parent, 810, 130, 150, 150, design.background, 0.72);
  } else if (motif === "motion-lines") {
    for (let row = 0; row < 5; row += 1) addRect(parent, 65, 815 + row * 19, 250 + row * 70, 3, design.accent, 0.12 + row * 0.025);
  } else if (motif === "precision-grid") {
    for (let row = 0; row < 5; row += 1) addRect(parent, 830 + row * 28, 70, 2, 210, design.accent, 0.11);
    for (let row = 0; row < 5; row += 1) addRect(parent, 780, 95 + row * 28, 210, 2, design.accent, 0.11);
  } else if (motif === "material-dots") {
    for (let row = 0; row < 4; row += 1) {
      for (let column = 0; column < 4; column += 1) addEllipse(parent, 820 + column * 42, 755 + row * 42, 6, 6, design.accent, 0.18);
    }
  }
}

function addImage(parent, bitmap, box) {
  const ratio = bitmap.width / bitmap.height;
  let width = box.productWidth;
  let height = width / ratio;
  if (height > box.productHeight) {
    height = box.productHeight;
    width = height * ratio;
  }
  const node = editor.createImageContainer(bitmap, { initialSize: { width, height } });
  node.translation = {
    x: box.productX + (box.productWidth - width) / 2,
    y: box.productY + (box.productHeight - height) / 2
  };
  parent.children.append(node);
}

function addBackgroundImage(parent, bitmap, design) {
  if (!bitmap) return;
  const ratio = bitmap.width / bitmap.height;
  const width = ratio >= 1 ? SIZE * ratio : SIZE;
  const height = ratio >= 1 ? SIZE : SIZE / ratio;
  const node = editor.createImageContainer(bitmap, { initialSize: { width, height } });
  node.translation = { x: (SIZE - width) / 2, y: (SIZE - height) / 2 };
  parent.children.append(node);
  addRect(parent, 0, 0, SIZE, SIZE, design.background, design.overlayOpacity === undefined ? 0.58 : design.overlayOpacity);
}

function buildPage(design, bitmap, backgroundBitmap, index) {
  try {
    const page = editor.documentRoot.pages.addPage({ width: SIZE, height: SIZE });
    const artboard = page.artboards.first;
    if (!artboard) throw new Error("New page did not contain an artboard");
    const box = design.composition;
    addRect(artboard, 0, 0, SIZE, SIZE, design.background);
    addBackgroundImage(artboard, backgroundBitmap, design);
    addDecoration(artboard, design, index);
    if (design.imageTreatment === "editorial-card") {
      addRect(artboard, box.productX + 16, box.productY + 18, box.productWidth, box.productHeight, "#000000", 0.18);
      addRect(artboard, box.productX, box.productY, box.productWidth, box.productHeight, "#FFFFFF", 0.94);
    } else if (design.imageTreatment === "isolated-stage") {
      addEllipse(artboard, box.productX + box.productWidth * 0.04, box.productY + box.productHeight * 0.72, box.productWidth * 0.46, 54, design.accent, 0.18);
    }
    addImage(artboard, bitmap, box);
    addText(artboard, design.eyebrow.toUpperCase(), box.textX, box.textY, box.textWidth, 22, design.accent, 130);
    addText(artboard, design.headline, box.textX, box.textY + 48, box.textWidth, box.headlineSize, design.textColor, -20);
    addText(artboard, design.subheadline, box.textX, Math.min(870, box.textY + 300), box.textWidth, 24, design.textColor, 2);
    addRect(artboard, 65, 990, 950, 2, design.textColor, 0.28);
    const pageNumber = index + 1 < 10 ? `0${index + 1}` : String(index + 1);
    addText(artboard, pageNumber, 65, 1010, 100, 18, design.textColor, 90);
    addText(artboard, "VISION-DIRECTED PRODUCT SERIES", 700, 1010, 315, 14, design.textColor, 70);
    return page.id;
  } catch (error) {
    throw stageError(`page ${index + 1}`, error);
  }
}

async function commitPack(designs, blobs, backgroundBlobs, pageIdsToReplace) {
  if (!Array.isArray(designs) || designs.length < 1) throw new Error("At least one design is required.");
  if (!Array.isArray(blobs) || blobs.length < 1) throw new Error("At least one product image is required.");

  let bitmaps;
  let backgroundBitmaps;
  try {
    // VisionCraft's important invariant: start every mutating load before the
    // first await, then wait for the complete batch.
    const pendingLoads = [];
    for (let index = 0; index < blobs.length; index += 1) {
      pendingLoads.push(editor.loadBitmapImage(blobs[index]));
    }
    const pendingBackgroundLoads = [];
    const safeBackgroundBlobs = Array.isArray(backgroundBlobs) ? backgroundBlobs : [];
    for (let index = 0; index < safeBackgroundBlobs.length; index += 1) {
      pendingBackgroundLoads.push(editor.loadBitmapImage(safeBackgroundBlobs[index]));
    }
    const loaded = await Promise.all([Promise.all(pendingLoads), Promise.all(pendingBackgroundLoads)]);
    bitmaps = loaded[0];
    backgroundBitmaps = loaded[1];
  } catch (error) {
    throw stageError("product image preload", error);
  }

  try {
    if (typeof editor.keepContentActiveDuringAsync !== "function") {
      throw new Error("keepContentActiveDuringAsync is unavailable in this Adobe runtime");
    }

    // Reacquire an active page after image loading. All document mutations live
    // in the synchronous follow-up, as required by Adobe's current API.
    const activePage = editor.context.currentPage;
    if (!activePage) throw new Error("No active Adobe Express page was found");
    const newPageIds = [];
    await editor.keepContentActiveDuringAsync(
      activePage,
      async () => undefined,
      () => {
        const oldPages = [];
        if (Array.isArray(pageIdsToReplace) && pageIdsToReplace.length) {
          for (const page of editor.documentRoot.pages) {
            if (pageIdsToReplace.indexOf(page.id) >= 0) oldPages.push(page);
          }
        }
        for (let index = 0; index < designs.length; index += 1) {
          const imageIndex = Number(designs[index].imageIndex) % bitmaps.length;
          const requestedBackgroundIndex = Number(designs[index].backgroundIndex);
          const backgroundBitmap = requestedBackgroundIndex >= 0 && backgroundBitmaps.length
            ? backgroundBitmaps[requestedBackgroundIndex % backgroundBitmaps.length]
            : undefined;
          newPageIds.push(buildPage(designs[index], bitmaps[imageIndex], backgroundBitmap, index));
        }
        for (const oldPage of oldPages) oldPage.removeFromParent();
      }
    );
    return newPageIds;
  } catch (error) {
    if (error && typeof error.message === "string" && error.message.indexOf("Adobe renderer failed at") === 0) throw error;
    throw stageError("document commit", error);
  }
}

async function renderPack(designs, blobs, backgroundBlobs) {
  const pageIds = await commitPack(designs, blobs, backgroundBlobs, []);
  return { message: "First Adobe pass created.", pageIds };
}

async function replacePack(designs, blobs, backgroundBlobs, pageIds) {
  const replacementPageIds = await commitPack(designs, blobs, backgroundBlobs, pageIds);
  return { message: "Done — the visual critic revised and replaced the editable Adobe design.", pageIds: replacementPageIds };
}

async function renderManualDesign(design, productBlob, backgroundBlob) {
  if (!design || !productBlob) throw new Error("A design specification and product image are required.");
  let bitmap;
  let backgroundBitmap;
  try {
    // Start every mutating image load before the first await.
    const productLoad = editor.loadBitmapImage(productBlob);
    const backgroundLoad = backgroundBlob ? editor.loadBitmapImage(backgroundBlob) : Promise.resolve(undefined);
    const loaded = await Promise.all([productLoad, backgroundLoad]);
    bitmap = loaded[0];
    backgroundBitmap = loaded[1];
  } catch (error) {
    throw stageError("manual edit image preload", error);
  }
  try {
    const activePage = editor.context.currentPage;
    if (!activePage) throw new Error("No active Adobe Express page was found");
    let pageId = "";
    await editor.keepContentActiveDuringAsync(
      activePage,
      async () => undefined,
      () => { pageId = buildPage(design, bitmap, backgroundBitmap, 0); }
    );
    return { message: "Editable Adobe page created. Make changes, then save the revision.", pageId };
  } catch (error) {
    throw stageError("manual edit document commit", error);
  }
}

function capabilities() {
  return {
    loadBitmapImage: typeof editor.loadBitmapImage === "function",
    keepContentActiveDuringAsync: typeof editor.keepContentActiveDuringAsync === "function",
    addPage: Boolean(editor.documentRoot && editor.documentRoot.pages && typeof editor.documentRoot.pages.addPage === "function"),
    createRectangle: typeof editor.createRectangle === "function",
    createEllipse: typeof editor.createEllipse === "function",
    createText: typeof editor.createText === "function",
    boundedText: Boolean(constants && constants.TextLayout && constants.TextLayout.autoHeight !== undefined),
    createImageContainer: typeof editor.createImageContainer === "function"
  };
}

runtime.exposeApi({
  ready: () => true,
  capabilities,
  renderPack,
  replacePack,
  renderManualDesign
});
