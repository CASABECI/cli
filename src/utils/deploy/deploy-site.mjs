import { rm } from 'fs/promises'

import cleanDeep from 'clean-deep'
import { temporaryDirectory } from 'tempy'

import { deployFileNormalizer, getDistPathIfExists, isEdgeFunctionFile } from '../../lib/edge-functions/deploy.mjs'
import { warn } from '../command-helpers.mjs'

import {
  DEFAULT_CONCURRENT_HASH,
  DEFAULT_CONCURRENT_UPLOAD,
  DEFAULT_DEPLOY_TIMEOUT,
  DEFAULT_MAX_RETRY,
  DEFAULT_SYNC_LIMIT,
} from './constants.mjs'
import hashFiles from './hash-files.mjs'
import hashFns from './hash-fns.mjs'
import uploadFiles from './upload-files.mjs'
import { getUploadList, waitForDeploy, waitForDiff } from './util.mjs'

export const deploySite = async (
  api,
  siteId,
  dir,
  {
    assetType,
    branch,
    concurrentHash = DEFAULT_CONCURRENT_HASH,
    concurrentUpload = DEFAULT_CONCURRENT_UPLOAD,
    configPath = null,
    deployId,
    deployTimeout = DEFAULT_DEPLOY_TIMEOUT,
    draft = false,
    filter,
    fnDir = [],
    functionsConfig,
    hashAlgorithm,
    manifestPath,
    maxRetry = DEFAULT_MAX_RETRY,
    siteEnv,
    siteRoot,
    skipFunctionsCache,
    statusCb = () => {
      /* default to noop */
    },
    syncFileLimit = DEFAULT_SYNC_LIMIT,
    tmpDir = temporaryDirectory(),
    workingDir,
  } = {},
) => {
  statusCb({
    type: 'hashing',
    msg: `Hashing files...`,
    phase: 'start',
  })

  const edgeFunctionsDistPath = await getDistPathIfExists(workingDir)
  const [{ files, filesShaMap }, { fnConfig, fnShaMap, functionSchedules, functions, functionsWithNativeModules }] =
    await Promise.all([
      hashFiles({
        assetType,
        concurrentHash,
        directories: [configPath, dir, edgeFunctionsDistPath].filter(Boolean),
        filter,
        hashAlgorithm,
        normalizer: deployFileNormalizer.bind(null, workingDir),
        statusCb,
      }),
      hashFns(fnDir, {
        functionsConfig,
        tmpDir,
        concurrentHash,
        hashAlgorithm,
        statusCb,
        assetType,
        workingDir,
        manifestPath,
        skipFunctionsCache,
        siteEnv,
        rootDir: siteRoot,
      }),
    ])
  const edgeFunctionsCount = Object.keys(files).filter(isEdgeFunctionFile).length
  const filesCount = Object.keys(files).length - edgeFunctionsCount
  const functionsCount = Object.keys(functions).length
  const stats = buildStatsString([
    filesCount > 0 && `${filesCount} files`,
    functionsCount > 0 && `${functionsCount} functions`,
    edgeFunctionsCount > 0 && 'edge functions',
  ])

  statusCb({
    type: 'hashing',
    msg: `Finished hashing ${stats}`,
    phase: 'stop',
  })

  if (filesCount === 0 && functionsCount === 0) {
    throw new Error('No files or functions to deploy')
  }

  if (functionsWithNativeModules.length !== 0) {
    warn(`Modules with native dependencies\n
${functionsWithNativeModules.map(({ name }) => `- ${name}`).join('\n')}

The serverless functions above use Node.js modules with native dependencies, which
must be installed on a system with the same architecture as the function runtime. A
mismatch in the system and runtime may lead to errors when invoking your functions.
To ensure your functions work as expected, we recommend using continuous deployment
instead of manual deployment.

For more information, visit https://ntl.fyi/cli-native-modules.`)
  }

  statusCb({
    type: 'create-deploy',
    msg: 'CDN diffing files...',
    phase: 'start',
  })

  const deployParams = cleanDeep({
    siteId,
    deploy_id: deployId,
    body: {
      files,
      functions,
      function_schedules: functionSchedules,
      functions_config: fnConfig,
      async: Object.keys(files).length > syncFileLimit,
      branch,
      draft,
    },
  })
  let deploy = await api.updateSiteDeploy(deployParams)

  if (deployParams.body.async) deploy = await waitForDiff(api, deploy.id, siteId, deployTimeout)

  const { required: requiredFiles, required_functions: requiredFns } = deploy

  statusCb({
    type: 'create-deploy',
    msg: `CDN requesting ${requiredFiles.length} files${
      Array.isArray(requiredFns) ? ` and ${requiredFns.length} functions` : ''
    }`,
    phase: 'stop',
  })

  const filesUploadList = getUploadList(requiredFiles, filesShaMap)
  const functionsUploadList = getUploadList(requiredFns, fnShaMap)
  const uploadList = [...filesUploadList, ...functionsUploadList]

  await uploadFiles(api, deployId, uploadList, { concurrentUpload, statusCb, maxRetry })

  statusCb({
    type: 'wait-for-deploy',
    msg: 'Waiting for deploy to go live...',
    phase: 'start',
  })
  deploy = await waitForDeploy(api, deployId, siteId, deployTimeout)

  statusCb({
    type: 'wait-for-deploy',
    msg: draft ? 'Draft deploy is live!' : 'Deploy is live!',
    phase: 'stop',
  })

  await rm(tmpDir, { force: true, recursive: true })

  const deployManifest = {
    deployId,
    deploy,
    uploadList,
  }
  return deployManifest
}

const buildStatsString = (possibleParts) => {
  const parts = possibleParts.filter(Boolean)
  const message = parts.slice(0, -1).join(', ')

  return parts.length > 1 ? `${message} and ${parts[parts.length - 1]}` : message
}
