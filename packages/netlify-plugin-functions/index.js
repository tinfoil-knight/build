const path = require('path')
const { zipFunction } = require('@netlify/zip-it-and-ship-it')
const fs = require('fs-extra')

function netlifyFunctionsPlugin(conf = {}) {
  return {
    postbuild: async ({ netlifyConfig }) => {
      console.log('Configuring Functions...')
      if (!conf.functions) {
        throw new Error('You must provide functions to the functions plugin')
      }

      const buildFolder = path.join(process.cwd(), 'build')
      const destFolder = path.join(buildFolder, 'functions')

      const data = Object.keys(conf.functions).reduce((acc, functionName) => {
        const functionData = conf.functions[functionName]
        const functionPath = path.resolve(functionData.handler)

        // Add rewrites rules
        const originalPath = `/.netlify/functions/${functionName}`
        acc.rewrites = acc.rewrites.concat({
          fromPath: functionData.path,
          toPath: originalPath
        })

        console.log(`Mapping ${functionData.path} to ${originalPath}`)

        // configuration for functions
        acc.functions = acc.functions.concat({
          name: functionName,
          filename: functionData.handler,
          path: functionPath,
          method: functionData.method
        })

        return acc
      }, {
        functions: [],
        rewrites: [],
        redirects: []
      })

      const processFuncs = data.functions.map(async (func) => {
        return processFunction(func, destFolder)
      })

      await Promise.all(processFuncs)

      // Write to redirects file
      await writeRedirectsFile(buildFolder, data.redirects, data.rewrites)

      console.log('Functions ready!')
    }
  }
}

async function processFunction(func, destFolder) {
  const tempPath = tempFileName(func.path)
  // Cleanup from failed build
  if (await fs.exists(tempPath)) {
    const content = await fs.readFile(func.path)
    if (content.match(/Netlify function wrapper/)) {
      // Reset original source code
      await fs.copy(tempPath, func.path)
    }
  }
  // Create copy of original function handler
  await fs.copy(func.path, tempPath)
  // Wrap function code
  console.log(`Wrapping function ${func.name}...`)
  const handler = generateHandler(func)
  // Write new function code to original file
  await fs.writeFile(func.path, handler)
  // Zip it up the wrapped function
  console.log(`Packaging function ${func.name}...`)
  await packageFunction(func.path, destFolder)
  // copy original function code back
  await fs.copy(tempPath, func.path)
  // Delete backup
  await fs.unlink(tempPath)
  return handler
}

function tempFileName(filePath) {
  return filePath.replace(/\.js$/, '-temp.js')
}

async function packageFunction(functionPath, destFolder) {
  await fs.ensureDir(destFolder)
  await zipFunction(functionPath, destFolder)
}

function generateHandler(func) {
  const { name, method } = func
  const tempFile = path.basename(tempFileName(func.path))
  return `
/* Netlify function wrapper */
let originalFunction, handlerError
try {
  originalFunction = require('./${tempFile}')
} catch (err) {
  handlerError = err
}

exports['handler'] = function ${name}(event, context, callback) {
  if (handlerError) {
    return callback(handlerError)
  }
  if (event.httpMethod !== "${method}") {
    const errorMessage = \`"\${event.httpMethod}" not allowed\`
    console.log(errorMessage)
    return callback(errorMessage)
  }
  try {
    return originalFunction['handler'](event, context, callback)
  } catch (err) {
    throw err
  }
}`
}

const HEADER_COMMENT = `## Created with netlify functions plugin`

async function writeRedirectsFile(buildDir, redirects, rewrites) {
  if (!redirects.length && !rewrites.length) {
    return null
  }

  const FILE_PATH = path.join(buildDir, `_redirects`)

  // Map redirect data to the format Netlify expects
  // https://www.netlify.com/docs/redirects/
  redirects = redirects.map(redirect => {
    const {
      fromPath,
      isPermanent,
      redirectInBrowser, // eslint-disable-line no-unused-vars
      force,
      toPath,
      statusCode,
      ...rest
    } = redirect

    let status = isPermanent ? `301` : `302`
    if (statusCode) {
      status = statusCode
    }

    if (force) {
      status = status.concat(`!`)
    }

    // The order of the first 3 parameters is significant.
    // The order for rest params (key-value pairs) is arbitrary.
    const pieces = [fromPath, toPath, status]

    for (let key in rest) {
      const value = rest[key]

      if (typeof value === `string` && value.indexOf(` `) >= 0) {
        console.warn(
          `Invalid redirect value "${value}" specified for key "${key}". ` +
            `Values should not contain spaces.`
        )
      } else {
        pieces.push(`${key}=${value}`)
      }
    }

    return pieces.join(`  `)
  })

  rewrites = rewrites.map(
    ({ fromPath, toPath }) => `${fromPath}  ${toPath}  200`
  )
  let appendToFile = false

  // Websites may also have statically defined redirects
  // In that case we should append to them (not overwrite)
  // Make sure we aren't just looking at previous build results though
  const fileExists = await fs.exists(FILE_PATH)
  if (fileExists) {
    const fileContents = await fs.readFile(FILE_PATH)
    if (fileContents.indexOf(HEADER_COMMENT) < 0) {
      appendToFile = true
    }
  }

  const data = `${HEADER_COMMENT}\n\n${[...redirects, ...rewrites].join(`\n`)}`

  return appendToFile
    ? fs.appendFile(FILE_PATH, `\n\n${data}`)
    : fs.writeFile(FILE_PATH, data)
}

module.exports = netlifyFunctionsPlugin
