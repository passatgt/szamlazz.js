import assert from 'assert'
import merge from 'merge'
import axios from 'axios'
import FormData from 'form-data'
import { parseString, wrapWithElement, xml2obj, removeNamespaces } from './XMLUtils.js'
import { HttpsCookieAgent } from 'http-cookie-agent/http'
import tough from 'tough-cookie'
import { CreditEntry } from './CreditEntry.js';

const defaultOptions = {
  eInvoice: false,
  requestInvoiceDownload: false,
  downloadedInvoiceCount: 1,
  responseVersion: 1,
  timeout: 0,
}

export class Client {
  /**
   * @type {axios.AxiosInstance}
   */
  #axiosInstance

  constructor (options) {
    this._options = merge({}, defaultOptions, options || {})

    this.useToken = typeof this._options.authToken === 'string' && this._options.authToken.trim().length > 1

    if (!this.useToken) {
      assert(typeof this._options.user === 'string' && this._options.user.trim().length > 1,
      'Valid User field missing form client options')

      assert(typeof this._options.password === 'string' && this._options.password.trim().length > 1,
      'Valid Password field missing form client options')
    }

    this._cookieJar = new tough.CookieJar()
    this.#axiosInstance = axios.create({
      httpsAgent: new HttpsCookieAgent({ cookies: { jar: this._cookieJar } }),
    })
  }

  async getInvoiceData (options) {
    const hasInvoiceId = typeof options.invoiceId === 'string' && options.invoiceId.trim().length > 1
    const hasOrderNumber = typeof options.orderNumber === 'string' && options.orderNumber.trim().length > 1
    assert(hasInvoiceId || hasOrderNumber, 'Either invoiceId or orderNumber must be specified')

    const xml = this._getXmlHeader('xmlszamlaxml', 'agentxml') +
      wrapWithElement([
        ...this._getAuthFields(),
        ['szamlaszam', options.invoiceId],
        ['rendelesSzam', options.orderNumber],
        ['pdf', options.pdf]
      ]) +
      '</xmlszamlaxml>'

    const response = await this._sendRequest('action-szamla_agent_xml', xml)
    const parsedBody = await parseString(response.data)

    return parsedBody.szamla
  }

  async reverseInvoice (options) {
    assert(typeof options.invoiceId === 'string' && options.invoiceId.trim().length > 1, 'invoiceId must be specified')
    assert(options.eInvoice !== undefined, 'eInvoice must be specified')
    assert(options.requestInvoiceDownload !== undefined, 'requestInvoiceDownload must be specified')

    const xml = this._getXmlHeader('xmlszamlast', 'agentst') +
      wrapWithElement(
        'beallitasok', [
          ...this._getAuthFields(),
          ['eszamla', String(options.eInvoice)],
          ['szamlaLetoltes', String(options.requestInvoiceDownload)],
        ]) +
      wrapWithElement(
        'fejlec', [
          ['szamlaszam', options.invoiceId],
          ['keltDatum', new Date()],
        ]) +
      '</xmlszamlast>'

    const httpResponse = await this._sendRequest('action-szamla_agent_st', xml, true)

    const data = {
      invoiceId: httpResponse.headers.szlahu_szamlaszam,
      netTotal: httpResponse.headers.szlahu_nettovegosszeg,
      grossTotal: httpResponse.headers.szlahu_bruttovegosszeg,
      customerAccountUrl: httpResponse.headers.szlahu_vevoifiokurl
    }

    if (options.requestInvoiceDownload) {
      data.pdf = httpResponse.data
    }

    return data
  }

  async issueInvoice (invoice) {
    const xml = this._getXmlHeader('xmlszamla', 'agent') +
      wrapWithElement('beallitasok', [
        ...this._getAuthFields(),
        [ 'eszamla', this._options.eInvoice ],
        [ 'szamlaLetoltes', this._options.requestInvoiceDownload ],
        [ 'szamlaLetoltesPld', this._options.downloadedInvoiceCount ],
        [ 'valaszVerzio', this._options.responseVersion ]
      ], 1) +
      invoice._generateXML(1) +
      '</xmlszamla>'

    const httpResponse = await this._sendRequest('action-xmlagentxmlfile', xml, this._options.responseVersion === 1)

    const data = {
      invoiceId: httpResponse.headers.szlahu_szamlaszam,
      netTotal: httpResponse.headers.szlahu_nettovegosszeg,
      grossTotal: httpResponse.headers.szlahu_bruttovegosszeg,
      customerAccountUrl: httpResponse.headers.szlahu_vevoifiokurl,
    }

    if (this._options.requestInvoiceDownload) {
      if (this._options.responseVersion === 1) {
        data.pdf = Buffer.from(httpResponse.data)
      } else if (this._options.responseVersion === 2) {
        const parsed = await xml2obj(httpResponse.data, { 'xmlszamlavalasz.pdf': 'pdf' })
        data.pdf = Buffer.from(parsed.pdf, 'base64')
      }
    }
    return data
  }

  async queryTaxPayer (taxPayerId) {
    assert(typeof taxPayerId === 'number' && /^[0-9]{8}$/.test(taxPayerId.toString()), 'taxPayerId must be an 8-digit number');

    const xml = this._getXmlHeader('xmltaxpayer', 'agent') +
      wrapWithElement(
        'beallitasok', [
          ...this._getAuthFields(),
        ], 1) +
        wrapWithElement('torzsszam', taxPayerId, 1) +
      '</xmltaxpayer>'

    const response = await this._sendRequest('action-szamla_agent_taxpayer', xml)
    const parsedBody = await parseString(response.data)
    const cleanParsedBody = removeNamespaces(parsedBody);
    const cleanParsedBodyData = cleanParsedBody.QueryTaxpayerResponse;
    const taxpayerValidity = cleanParsedBodyData.taxpayerValidity?.[0] === 'true';

    if (!taxpayerValidity) {
      return {
        taxpayerValidity: false,
      };
    }

    const taxpayerData = cleanParsedBodyData.taxpayerData?.[0] || {};
    const taxNumberDetail = taxpayerData.taxNumberDetail?.[0] || {};
  
    return {
      taxpayerValidity,
      taxpayerId: taxNumberDetail.taxpayerId?.[0] || null,
      vatCode: taxNumberDetail.vatCode?.[0] || null,
      countyCode: taxNumberDetail.countyCode?.[0] || null,
      taxpayerName: taxpayerData.taxpayerName?.[0] || null,
      taxpayerShortName: taxpayerData.taxpayerShortName?.[0] || null,
      address: this._extractAddress(taxpayerData.taxpayerAddressList?.[0]),
    };
  }

  async registerCreditEntry (options, creditEntries) {
    assert(typeof options.invoiceId === 'string' && options.invoiceId.trim().length > 1, 'invoiceId must be specified')
    assert(Array.isArray(creditEntries) && creditEntries.length > 0, 'creditEntries must be specified and must be an array')
    assert(creditEntries.every(entry => entry instanceof CreditEntry), 'All entries must be instances of CreditEntry')

    const xml = this._getXmlHeader('xmlszamlakifiz', 'agentkifiz') +
      wrapWithElement(
        'beallitasok', [
          ...this._getAuthFields(),
          ['szamlaszam', options.invoiceId],
          ['adoszam', options.taxNumber || ''],
          ['additiv', String(options.additive || true)],
        ], 1) +
        creditEntries.map(creditEntry => creditEntry._generateXML()).join('') +
      '</xmlszamlakifiz>'

    const httpResponse = await this._sendRequest('action-szamla_agent_kifiz', xml)
    const data = {
      invoiceId: httpResponse.headers.szlahu_szamlaszam,
      netTotal: httpResponse.headers.szlahu_nettovegosszeg,
      grossTotal: httpResponse.headers.szlahu_bruttovegosszeg,
    }
    
    return data
  }

  _extractAddress (addressList) {
    if (!addressList || !addressList.taxpayerAddressItem) return null;

    const addressItem = addressList.taxpayerAddressItem[0].taxpayerAddress?.[0] || {};
    return {
      countryCode: addressItem.countryCode?.[0] || null,
      postalCode: addressItem.postalCode?.[0] || null,
      city: addressItem.city?.[0] || null,
      streetName: addressItem.streetName?.[0] || null,
      publicPlaceCategory: addressItem.publicPlaceCategory?.[0] || null,
      number: addressItem.number?.[0] || null,
    };
  }

  _getXmlHeader (tag, dir) {
    return `<?xml version="1.0" encoding="UTF-8"?>
    <${tag} xmlns="http://www.szamlazz.hu/${tag}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
      xsi:schemaLocation="http://www.szamlazz.hu/${tag} https://www.szamlazz.hu/szamla/docs/xsds/${dir}/${tag}.xsd">\n`
  }

  _getAuthFields () {
    if (this.useToken) {
      return [
        [ 'szamlaagentkulcs', this._options.authToken ],
      ]
    }

    return [
      [ 'felhasznalo', this._options.user ],
      [ 'jelszo', this._options.password ],
    ]
  }

  async _sendRequest (fileFieldName, data, isBinaryDownload) {
    const formData = new FormData()
    formData.append(fileFieldName, data, 'request.xml')

    const axiosOptions = {
      headers: {
        ...formData.getHeaders()
      },
      jar: this._cookieJar,
      withCredentials: true,
      timeout: this._options.timeout,
    }

    if (isBinaryDownload) {
      axiosOptions.responseType = 'arraybuffer'
    }

    const httpResponse = await this.#axiosInstance.post('https://www.szamlazz.hu/szamla/', formData.getBuffer(), axiosOptions)
    if (httpResponse.status !== 200) {
      throw new Error(`${httpResponse.status} ${httpResponse.statusText}`)
    }

    if (httpResponse.headers.szlahu_error_code) {
      const err = new Error(decodeURIComponent(httpResponse.headers.szlahu_error.replace(/\+/g, ' ')))
      err.code = httpResponse.headers.szlahu_error_code
      throw err
    }

    if (isBinaryDownload || fileFieldName === 'action-szamla_agent_kifiz') { // credit entry response is just a string, not XML
      return httpResponse
    }

    const parsedBody = await parseString(httpResponse.data)

    if (parsedBody.xmlszamlavalasz && parsedBody.xmlszamlavalasz.hibakod) {
      const error = new Error(parsedBody.xmlszamlavalasz.hibauzenet)
      error.code = parsedBody.xmlszamlavalasz.hibakod[0]
      throw error
    }

    return httpResponse
  }

  setRequestInvoiceDownload (value) {
    this._options.requestInvoiceDownload = value
  }
}
