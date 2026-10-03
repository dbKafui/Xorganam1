import sanitizeHtml from 'sanitize-html'

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/
const FONTS = new Set(['Inter', 'Roboto', 'Merriweather', 'Lora', 'IBM Plex Sans', 'IBM Plex Mono'])
const RICH_TEXT_OPTIONS = {
  allowedTags: ['p', 'br', 'strong', 'em', 'ul', 'ol', 'li', 'a', 'h1', 'h2', 'h3', 'blockquote', 'img'],
  allowedAttributes: { a: ['href'], img: ['src', 'alt'] },
  allowedSchemes: ['https'],
  allowedSchemesByTag: { img: ['https'] },
  transformTags: { a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer', target: '_blank' }) },
  disallowedTagsMode: 'discard'
}

function validHttpsUrl(value, field, optional = false) {
  if ((value === undefined || value === null || value === '') && optional) return undefined
  let url
  try { url = new URL(String(value)) } catch { throw new Error(`${field} must be a valid HTTPS URL.`) }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error(`${field} must be a valid HTTPS URL without credentials.`)
  return url.toString()
}

function color(value, field, optional = false) {
  if ((value === undefined || value === null || value === '') && optional) return undefined
  if (typeof value !== 'string' || !HEX_COLOR.test(value)) throw new Error(`${field} must be a six-digit hex color.`)
  return value
}

function validateStyle(style, field) {
  if (style === undefined) return undefined
  if (!style || typeof style !== 'object' || Array.isArray(style)) throw new Error(`${field} must be an object.`)
  const output = {}
  const allowed = new Set(['color', 'backgroundColor', 'padding', 'margin', 'borderRadius', 'fontSize', 'textAlign', 'fontFamily'])
  for (const [key, value] of Object.entries(style)) {
    if (!allowed.has(key)) throw new Error(`${field}.${key} is not a supported style property.`)
    if (['color', 'backgroundColor'].includes(key)) output[key] = color(value, `${field}.${key}`)
    else if (key === 'fontFamily') {
      if (!FONTS.has(value)) throw new Error(`${field}.fontFamily must be a supported font.`)
      output[key] = value
    } else if (key === 'textAlign') {
      if (!['left', 'center', 'right'].includes(value)) throw new Error(`${field}.textAlign must be left, center, or right.`)
      output[key] = value
    } else {
      const number = Number(value)
      if (!Number.isFinite(number) || number < 0 || number > 120) throw new Error(`${field}.${key} must be between 0 and 120.`)
      output[key] = number
    }
  }
  return output
}

function stringProp(props, key, max, required = false) {
  const value = props[key]
  if (value === undefined && !required) return undefined
  if (typeof value !== 'string' || (required && !value.trim()) || value.length > max) {
    throw new Error(`blocks.${key} must be a ${required ? 'non-empty ' : ''}string of at most ${max} characters.`)
  }
  return value
}

function validateBlock(block, index) {
  const path = `blocks[${index}]`
  if (!block || typeof block !== 'object' || Array.isArray(block) || !['hero', 'product_grid', 'rich_text'].includes(block.type)) {
    throw new Error(`${path}.type must be hero, product_grid, or rich_text.`)
  }
  const props = block.props || {}
  if (!props || typeof props !== 'object' || Array.isArray(props)) throw new Error(`${path}.props must be an object.`)
  const output = { type: block.type, props: {} }
  if (block.type === 'hero') {
    output.props.headline = stringProp(props, 'headline', 180, true)
    output.props.subheadline = stringProp(props, 'subheadline', 500)
    output.props.imageUrl = validHttpsUrl(props.imageUrl, `${path}.props.imageUrl`, true)
    output.props.backgroundColor = color(props.backgroundColor, `${path}.props.backgroundColor`, true)
    output.props.textColor = color(props.textColor, `${path}.props.textColor`, true)
    output.props.style = validateStyle(props.style, `${path}.props.style`)
  } else if (block.type === 'product_grid') {
    output.props.title = stringProp(props, 'title', 120)
    output.props.categoryId = stringProp(props, 'categoryId', 80)
    if (props.productIds !== undefined) {
      if (!Array.isArray(props.productIds) || props.productIds.length > 100 || props.productIds.some((id) => typeof id !== 'string' || id.length > 80)) {
        throw new Error(`${path}.props.productIds must contain at most 100 IDs.`)
      }
      output.props.productIds = [...new Set(props.productIds)]
    }
    const columns = props.columns === undefined ? 3 : Number(props.columns)
    if (!Number.isInteger(columns) || columns < 1 || columns > 4) throw new Error(`${path}.props.columns must be between 1 and 4.`)
    output.props.columns = columns
    output.props.backgroundColor = color(props.backgroundColor, `${path}.props.backgroundColor`, true)
    output.props.textColor = color(props.textColor, `${path}.props.textColor`, true)
    output.props.style = validateStyle(props.style, `${path}.props.style`)
  } else {
    const html = stringProp(props, 'html', 50000, true)
    output.props.html = sanitizeHtml(html, RICH_TEXT_OPTIONS)
    output.props.textColor = color(props.textColor, `${path}.props.textColor`, true)
    output.props.backgroundColor = color(props.backgroundColor, `${path}.props.backgroundColor`, true)
    output.props.style = validateStyle(props.style, `${path}.props.style`)
  }
  return output
}

export function sanitizeBrandingConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('brandingConfig must be an object.')
  const theme = input.theme || {}
  if (!theme || typeof theme !== 'object' || Array.isArray(theme)) throw new Error('theme must be an object.')
  const output = {
    theme: {
      primaryColor: color(theme.primaryColor ?? '#1a2b3c', 'theme.primaryColor'),
      font: theme.font ?? 'Inter',
      logoUrl: validHttpsUrl(theme.logoUrl, 'theme.logoUrl', true)
    },
    blocks: input.blocks ?? []
  }
  if (!FONTS.has(output.theme.font)) throw new Error(`theme.font must be one of: ${[...FONTS].join(', ')}.`)
  if (!Array.isArray(output.blocks) || output.blocks.length > 40) throw new Error('blocks must be an array of at most 40 blocks.')
  output.blocks = output.blocks.map(validateBlock)
  return output
}

export function validateStorefrontImageUrl(value, field = 'image URL') {
  return validHttpsUrl(value, field)
}
