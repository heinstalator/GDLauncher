import axios from "axios";
import path from "path";
import { remote, ipcRenderer } from "electron";
import uuid from "uuid/v1";
import fse from "fs-extra";
import semver, { coerce } from "semver";
import omitBy from "lodash.omitby";
import { extractFull } from "node-7z";
import { push } from "connected-react-router";
import { promisify } from "util";
import { exec } from "child_process";
import makeDir from "make-dir";
import * as ActionTypes from "./actionTypes";
import { NEWS_URL, MC_RESOURCES_URL } from "../utils/constants";
import {
  mcAuthenticate,
  mcRefresh,
  mcInvalidate,
  getFabricManifest,
  getMcManifest,
  getForgeManifest,
  mcValidate,
  getLauncherManifest,
  getFabricJson,
  getForgeJson
} from "../api";
import {
  _getCurrentAccount,
  _getCurrentDownloadItem,
  _getJavaPath,
  _getMinecraftVersionsPath,
  _getAssetsPath,
  _getInstancesPath,
  _getLibrariesPath
} from "../utils/selectors";
import {
  librariesMapper,
  convertOSToMCFormat,
  get7zPath,
  readConfig,
  fixFilePermissions,
  extractNatives,
  getJVMArguments112,
  copyAssetsToResources,
  getJVMArguments113
} from "../../app/desktop/utils";
import { openModal, closeModal } from "./modals/actions";
import {
  downloadFile,
  downloadInstanceFiles
} from "../../app/desktop/utils/downloader";
import { updateJavaPath } from "./settings/actions";
import { removeDuplicates } from "../utils";

export function initManifests() {
  return async dispatch => {
    const mc = (await getMcManifest()).data;
    dispatch({
      type: ActionTypes.UPDATE_VANILLA_MANIFEST,
      data: mc
    });
    const fabric = (await getFabricManifest()).data;
    dispatch({
      type: ActionTypes.UPDATE_FABRIC_MANIFEST,
      data: fabric
    });
    const launcher = (await getLauncherManifest()).data;
    dispatch({
      type: ActionTypes.UPDATE_LAUNCHER_MANIFEST,
      data: launcher
    });
    const forge = removeDuplicates((await getForgeManifest()).data, "name");
    const forgeVersions = {};
    // Looping over vanilla versions, create a new entry in forge object
    // and add to it all correct versions
    mc.versions.forEach(v => {
      forgeVersions[v.id] = forge
        .filter(
          ver =>
            ver.gameVersion === v.id &&
            semver.gte(coerce(ver.gameVersion), coerce("1.6.4"))
        )
        .map(ver => ver.name.replace("forge-", ""));
    });

    dispatch({
      type: ActionTypes.UPDATE_FORGE_MANIFEST,
      data: omitBy(forgeVersions, v => v.length === 0)
    });
    return {
      mc,
      fabric,
      launcher,
      forge
    };
  };
}

export function initNews() {
  return async (dispatch, getState) => {
    const {
      news,
      loading: { minecraftNews }
    } = getState();
    if (news.length === 0 && !minecraftNews.isRequesting) {
      try {
        const res = await axios.get(NEWS_URL);
        const newsArr = await Promise.all(
          res.data.article_grid.map(async item => {
            return {
              title: item.default_tile.title,
              description: item.default_tile.sub_header,
              // We need to get the header image of every article, since
              // the ones present in this json are thumbnails
              image: `https://minecraft.net${item.default_tile.image.imageURL}`,
              url: `https://minecraft.net${item.article_url}`
            };
          })
        );
        dispatch({
          type: ActionTypes.UPDATE_NEWS,
          news: newsArr.splice(0, 12)
        });
      } catch (err) {
        console.error(err.message);
      }
    }
  };
}

export function updateIsUpdateAvailable(isUpdateAvailable) {
  return dispatch => {
    dispatch({
      type: ActionTypes.UPDATE_IS_UPDATE_AVAILABLE,
      isUpdateAvailable
    });
  };
}

export function updateAccount(uuidVal, account) {
  return dispatch => {
    dispatch({
      type: ActionTypes.UPDATE_ACCOUNT,
      id: uuidVal,
      account
    });
    dispatch(updateCurrentAccountId(uuidVal));
  };
}

export function removeAccount(id) {
  return async (dispatch, getState) => {
    dispatch({
      type: ActionTypes.REMOVE_ACCOUNT,
      id
    });
    const { app } = getState();
    if (app.accounts.length > 0) {
      dispatch(updateCurrentAccountId(app.accounts[0].selectedProfile.id));
    } else {
      dispatch(updateCurrentAccountId(null));
    }
  };
}

export function updateIsNewUser(isNewUser) {
  return async dispatch => {
    dispatch({
      type: ActionTypes.UPDATE_IS_NEW_USER,
      isNewUser
    });
  };
}

export function updateCurrentAccountId(id) {
  return async dispatch => {
    dispatch({
      type: ActionTypes.UPDATE_CURRENT_ACCOUNT_ID,
      id
    });
  };
}

export function updateJavaStatus(status) {
  return async dispatch => {
    dispatch({
      type: ActionTypes.UPDATE_JAVA_DOWNLOAD,
      status
    });
  };
}

export function updateDownloadProgress(percentage) {
  return (dispatch, getState) => {
    const { currentDownload } = getState();
    dispatch({
      type: ActionTypes.UPDATE_DOWNLOAD_PROGRESS,
      instanceName: currentDownload,
      percentage: Number(percentage.toFixed())
    });
  };
}

export function downloadJava() {
  return async (dispatch, getState) => {
    const {
      app: { launcherManifest }
    } = getState();
    const mcOs = convertOSToMCFormat(process.platform);
    dispatch(openModal("JavaDownload"));
    const { version, url } = launcherManifest[mcOs][64].jre;
    const javaBaseFolder = path.join(remote.app.getPath("userData"), "java");
    const tempFolder = path.join(remote.app.getPath("userData"), "temp");
    await fse.remove(javaBaseFolder);
    const downloadLocation = path.join(tempFolder, path.basename(url));

    let i = 0;
    await downloadFile(downloadLocation, url, p => {
      if (i % 4 === 0) {
        ipcRenderer.send("update-progress-bar", parseInt(p, 10) / 100);
        dispatch(updateJavaStatus(p));
      }
      i += 1;
    });
    await makeDir(path.join(javaBaseFolder, version));

    const firstExtraction = extractFull(downloadLocation, tempFolder, {
      $bin: get7zPath()
    });
    await new Promise((resolve, reject) => {
      firstExtraction.on("end", () => {
        resolve();
      });
      firstExtraction.on("error", err => {
        reject(err);
      });
    });

    const secondExtraction = extractFull(
      path.join(tempFolder, path.basename(url, ".lzma")),
      path.join(javaBaseFolder, version),
      {
        $bin: get7zPath()
      }
    );
    await new Promise((resolve, reject) => {
      secondExtraction.on("end", () => {
        resolve();
      });
      secondExtraction.on("error", err => {
        reject(err);
      });
    });
    await fse.remove(tempFolder);

    await fixFilePermissions(_getJavaPath(getState()));

    dispatch(updateJavaPath(_getJavaPath(getState())));

    ipcRenderer.send("update-progress-bar", -1);
    dispatch(updateJavaStatus("downloaded"));
    dispatch(updateJavaStatus("downloaded"));
    dispatch(closeModal());
  };
}

export function login(username, password) {
  return async (dispatch, getState) => {
    const {
      app: { isNewUser, clientToken }
    } = getState();
    if (!username || !password) {
      throw new Error("No username or password provided");
    }
    try {
      const { data } = await mcAuthenticate(username, password, clientToken);
      dispatch(updateAccount(data.selectedProfile.id, data));

      if (!isNewUser) {
        dispatch(push("/home"));
      } else {
        dispatch(updateIsNewUser(false));
        dispatch(push("/onboarding"));
      }
    } catch (err) {
      console.error(err);
      throw new Error(err);
    }
  };
}

export function loginWithAccessToken() {
  return async (dispatch, getState) => {
    const state = getState();
    const { accessToken, selectedProfile, clientToken } = _getCurrentAccount(
      state
    );
    try {
      await mcValidate(accessToken, clientToken);
      dispatch(push("/home"));
    } catch (error) {
      console.error(error);
      // Trying refreshing the stored access token
      if (error.response && error.response.status === 403) {
        try {
          const { data } = await mcRefresh(accessToken, clientToken);
          dispatch(updateAccount(data.selectedProfile.id, data));
          dispatch(push("/home"));
        } catch (nestedError) {
          console.error(error, nestedError);
          dispatch(removeAccount(selectedProfile.id));
          dispatch(push("/"));
          throw new Error();
        }
      } else if (error.message === "Network Error") {
        dispatch(push("/home"));
      }
    }
  };
}

export function loginThroughNativeLauncher() {
  return async (dispatch, getState) => {
    const {
      app: { isNewUser }
    } = getState();

    const homedir = remote.app.getPath("appData");
    const mcFolder = process.platform === "darwin" ? "minecraft" : ".minecraft";
    const vanillaMCPath = path.join(homedir, mcFolder);
    const vnlJson = await fse.readJson(
      path.join(vanillaMCPath, "launcher_profiles.json")
    );

    try {
      const { clientToken } = vnlJson;
      const { account } = vnlJson.selectedUser;
      const { accessToken } = vnlJson.authenticationDatabase[account];

      const { data } = await mcRefresh(accessToken, clientToken);

      // We need to update the accessToken in launcher_profiles.json
      vnlJson.authenticationDatabase[account].accessToken = data.accessToken;
      await fse.writeJson(
        path.join(vanillaMCPath, "launcher_profiles.json"),
        vnlJson
      );

      dispatch(updateAccount(data.selectedProfile.id, data));

      if (isNewUser) {
        dispatch(updateIsNewUser(false));
        dispatch(push("/onboarding"));
      } else {
        dispatch(push("/home"));
      }
    } catch (err) {
      throw new Error(err);
    }
  };
}

export function logout() {
  return (dispatch, getState) => {
    const state = getState();
    const {
      clientToken,
      accessToken,
      selectedProfile: { id }
    } = _getCurrentAccount(state);
    mcInvalidate(accessToken, clientToken).catch(console.error);
    dispatch(removeAccount(id));
    dispatch(push("/"));
  };
}

export function checkClientToken() {
  return (dispatch, getState) => {
    const {
      app: { clientToken }
    } = getState();
    if (clientToken) return clientToken;
    const newToken = uuid()
      .split("")
      .filter(v => v !== "-")
      .join("");
    dispatch({
      type: ActionTypes.UPDATE_CLIENT_TOKEN,
      clientToken: newToken
    });
    return newToken;
  };
}

export function updateModsManifests(modManifest) {
  return (dispatch, getState) => {
    const {
      app: { modsManifests }
    } = getState();
    if (!modsManifests.find(v => v.projectID === modManifest.projectID)) {
      dispatch({
        type: ActionTypes.UPDATE_MODS_MANIFESTS,
        id: modManifest.projectID,
        modManifest
      });
    }
  };
}

export function removeModsManifests(id) {
  return dispatch => {
    dispatch({
      type: ActionTypes.REMOVE_MOD_MANIFEST,
      id
    });
  };
}

export function updateCurrentDownload(instanceName) {
  return dispatch => {
    dispatch({
      type: ActionTypes.UPDATE_CURRENT_DOWNLOAD,
      instanceName
    });
  };
}

export function updateSelectedInstance(name) {
  return dispatch => {
    dispatch({
      type: ActionTypes.UPDATE_SELECTED_INSTANCE,
      name
    });
  };
}

export function removeDownloadFromQueue(instanceName) {
  return dispatch => {
    dispatch({
      type: ActionTypes.UPDATE_CURRENT_DOWNLOAD,
      instanceName: null
    });
    dispatch({
      type: ActionTypes.REMOVE_DOWNLOAD_FROM_QUEUE,
      instanceName
    });
  };
}

export function updateDownloadStatus(instanceName, status) {
  return dispatch => {
    dispatch({
      type: ActionTypes.UPDATE_DOWNLOAD_STATUS,
      status,
      instanceName
    });
  };
}

export function updateDownloadCurrentPhase(instanceName, status) {
  return dispatch => {
    dispatch({
      type: ActionTypes.UPDATE_DOWNLOAD_STATUS,
      status,
      instanceName
    });
  };
}

export function addToQueue(instanceName, mcVersion, modloader) {
  return (dispatch, getState) => {
    const { currentDownload } = getState();
    dispatch({
      type: ActionTypes.ADD_DOWNLOAD_TO_QUEUE,
      instanceName,
      mcVersion,
      modloader
    });
    fse.outputJson(
      path.join(_getInstancesPath(getState()), instanceName, "config.json"),
      {
        mcVersion,
        timePlayed: 0
      }
    );
    if (!currentDownload) {
      dispatch(updateCurrentDownload(instanceName));
      dispatch(downloadInstance(instanceName));
    }
  };
}

export function addNextInstanceToCurrentDownload() {
  return (dispatch, getState) => {
    const { downloadQueue } = getState();
    const queueArr = Object.keys(downloadQueue);
    if (queueArr.length > 0) {
      dispatch(updateCurrentDownload(queueArr[0]));
      dispatch(downloadInstance(queueArr[0]));
    }
  };
}

export function downloadFabric(instanceName) {
  return async (dispatch, getState) => {
    const state = getState();
    const { modloader } = _getCurrentDownloadItem(state);

    dispatch(updateDownloadStatus(instanceName, "Downloading fabric files"));

    let fabricJson;
    const fabricJsonPath = path.join(
      _getLibrariesPath(state),
      "net",
      "fabricmc",
      modloader[1],
      modloader[2],
      "fabric.json"
    );
    try {
      fabricJson = await fse.readJson(fabricJsonPath);
    } catch (err) {
      fabricJson = (await getFabricJson(modloader)).data;
      await fse.outputJson(fabricJsonPath, fabricJson);
    }

    const libraries = librariesMapper(
      fabricJson.libraries,
      _getLibrariesPath(state)
    );

    const updatePercentage = downloaded => {
      dispatch(updateDownloadProgress((downloaded * 100) / libraries.length));
    };

    await downloadInstanceFiles(libraries, updatePercentage);
  };
}

export function downloadForge(instanceName) {
  return async (dispatch, getState) => {
    const state = getState();
    const { modloader } = _getCurrentDownloadItem(state);

    dispatch(updateDownloadStatus(instanceName, "Downloading forge files"));

    let forgeJson;
    const forgeJsonPath = path.join(
      _getLibrariesPath(state),
      "net",
      "minecraftforge",
      modloader[2],
      `${modloader[2]}.json`
    );
    try {
      forgeJson = await fse.readJson(forgeJsonPath);
    } catch (err) {
      forgeJson = JSON.parse((await getForgeJson(modloader)).data.versionJson);
      await fse.outputJson(forgeJsonPath, forgeJson);
    }

    const libraries = librariesMapper(
      forgeJson.libraries,
      _getLibrariesPath(state)
    );

    const updatePercentage = downloaded => {
      dispatch(updateDownloadProgress((downloaded * 100) / libraries.length));
    };

    await downloadInstanceFiles(libraries, updatePercentage);
  };
}

export function downloadInstance(instanceName) {
  return async (dispatch, getState) => {
    const state = getState();
    const {
      app: {
        vanillaManifest: { versions: mcVersions }
      }
    } = state;

    dispatch(updateDownloadStatus(instanceName, "Downloading game files"));

    const { mcVersion, modloader } = _getCurrentDownloadItem(state);

    let mcJson;

    // DOWNLOAD MINECRAFT JSON
    const mcJsonPath = path.join(
      _getMinecraftVersionsPath(state),
      `${mcVersion}.json`
    );
    try {
      mcJson = await fse.readJson(mcJsonPath);
    } catch (err) {
      const versionURL = mcVersions.find(v => v.id === mcVersion).url;
      mcJson = (await axios.get(versionURL)).data;
      await fse.outputJson(mcJsonPath, mcJson);
    }

    // COMPUTING MC ASSETS
    let assetsJson;
    const assetsFile = path.join(
      _getAssetsPath(state),
      "indexes",
      `${mcJson.assets}.json`
    );
    try {
      assetsJson = await fse.readJson(assetsFile);
    } catch (e) {
      assetsJson = (await axios.get(mcJson.assetIndex.url)).data;
      await fse.outputJson(assetsFile, assetsJson);
    }

    const mcMainFile = {
      url: mcJson.downloads.client.url,
      sha1: mcJson.downloads.client.sha1,
      path: path.join(_getMinecraftVersionsPath(state), `${mcJson.id}.jar`)
    };

    const assets = Object.entries(assetsJson.objects).map(
      ([assetKey, { hash }]) => ({
        url: `${MC_RESOURCES_URL}/${hash.substring(0, 2)}/${hash}`,
        type: "asset",
        sha1: hash,
        path: path.join(
          _getAssetsPath(state),
          "objects",
          hash.substring(0, 2),
          hash
        ),
        resourcesPath: path.join(
          _getInstancesPath(state),
          instanceName,
          "resources",
          assetKey
        )
      })
    );

    const libraries = librariesMapper(
      mcJson.libraries,
      _getLibrariesPath(state)
    );

    let timePlayed = 0;

    try {
      const prevConfig = await readConfig(
        path.join(_getInstancesPath(state), instanceName)
      );
      timePlayed = prevConfig.timePlayed;
    } catch {
      // Do nothing
    }

    await fse.outputJson(
      path.join(_getInstancesPath(state), instanceName, "config.json"),
      {
        mcVersion,
        ...(modloader && { modloader }),
        timePlayed
      }
    );

    const updatePercentage = downloaded => {
      dispatch(
        updateDownloadProgress(
          (downloaded * 100) / (assets.length + libraries.length + 1)
        )
      );
    };

    await downloadInstanceFiles(
      [...libraries, ...assets, mcMainFile],
      updatePercentage
    );

    await extractNatives(
      libraries,
      path.join(_getInstancesPath(state), instanceName)
    );

    if (assetsJson.map_to_resources) {
      await copyAssetsToResources(assets);
    }

    if (modloader && modloader[0] === "fabric") {
      await dispatch(downloadFabric(instanceName));
    } else if (modloader && modloader[0] === "forge") {
      await dispatch(downloadForge(instanceName));
    }

    dispatch(removeDownloadFromQueue(instanceName));
    dispatch(addNextInstanceToCurrentDownload());
  };
}

export const launchInstance = instanceName => {
  return async (dispatch, getState) => {
    const state = getState();
    const javaPath = _getJavaPath(state);
    const account = _getCurrentAccount(state);
    const librariesPath = _getLibrariesPath(state);
    const assetsPath = _getAssetsPath(state);
    const instancePath = path.join(_getInstancesPath(state), instanceName);
    const { mcVersion, modloader } = await readConfig(instancePath);
    const mcJson = await fse.readJson(
      path.join(_getMinecraftVersionsPath(state), `${mcVersion}.json`)
    );
    let libraries = [];
    let mcMainFile = {
      url: mcJson.downloads.client.url,
      sha1: mcJson.downloads.client.sha1,
      path: path.join(_getMinecraftVersionsPath(state), `${mcJson.id}.jar`)
    };

    if (modloader && modloader[0] === "fabric") {
      const fabricJsonPath = path.join(
        _getLibrariesPath(state),
        "net",
        "fabricmc",
        modloader[1],
        modloader[2],
        "fabric.json"
      );
      const fabricJson = await fse.readJson(fabricJsonPath);
      const fabricLibraries = librariesMapper(
        fabricJson.libraries,
        librariesPath
      );
      libraries = libraries.concat(fabricLibraries);
      // Replace classname
      mcJson.mainClass = fabricJson.mainClass;
    } else if (modloader && modloader[0] === "forge") {
      const forgeJsonPath = path.join(
        _getLibrariesPath(state),
        "net",
        "minecraftforge",
        modloader[2],
        `${modloader[2]}.json`
      );
      const forgeJson = await fse.readJson(forgeJsonPath);
      const forgeLibraries = librariesMapper(
        forgeJson.libraries,
        librariesPath
      );
      libraries = libraries.concat(forgeLibraries);
      // Replace classname
      mcJson.mainClass = forgeJson.mainClass;
      if (forgeJson.minecraftArguments) {
        mcJson.minecraftArguments = forgeJson.minecraftArguments;
      }
    }
    libraries = removeDuplicates(
      libraries.concat(librariesMapper(mcJson.libraries, librariesPath)),
      "url"
    );

    const getJvmArguments =
      mcJson.assets !== "legacy" &&
      semver.gte(coerce(mcJson.assets), coerce("1.13"))
        ? getJVMArguments113
        : getJVMArguments112;

    const jvmArguments = await getJvmArguments(
      libraries,
      mcMainFile,
      instancePath,
      assetsPath,
      mcJson,
      account
    );

    console.log(`"${javaPath}" ${jvmArguments.join(" ")}`);

    ipcRenderer.send("hide-window");

    try {
      await promisify(exec)(`"${javaPath}" ${jvmArguments.join(" ")}`, {
        cwd: instancePath,
        shell: true
      });
    } catch (err) {
      console.error(err);
    } finally {
      ipcRenderer.send("show-window");
    }
  };
};
