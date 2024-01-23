const xml2js = require('xml2js');
const moment = require('moment');
const utils = require('../../utils');
const format = require('./AirFormat');
const {
  AirParsingError,
  AirRuntimeError,
  AirFlightInfoRuntimeError,
  GdsRuntimeError,
} = require('./AirErrors');
const {
  RequestRuntimeError,
} = require('../../Request/RequestErrors');

const fareCalculationPattern = /^([\s\S]+)END($|\s)/;
const firstOriginPattern = /^(?:s-)?(?:\d{2}[a-z]{3}\d{2}\s+)?([a-z]{3})/i;
const noAgreementPattern = /NO AGENCY AGREEMENT/i;
const unableToRetreivePattern = /UNABLE TO RETRIEVE/i;
const ticketRetrieveErrorPattern = /HOST ERROR DURING TICKET RETRIEVE/i;
const accessedByAnotherTransactionPattern = /ACCESSED BY ANOTHER TRANSACTION/i;
const noValidFare = /NO VALID FARE FOR INPUT CRITERIA/;
const bookingStaleData = /failed refresh|data may be stale/i;

const BOOKING_STALE_DATA_ERROR_CODE = 1301;

const parseFareCalculation = (str) => {
  const fareCalculation = str.match(fareCalculationPattern)[1];
  const firstOrigin = str.match(firstOriginPattern);
  const roe = str.match(/ROE((?:\d+\.)?\d+)/);
  return {
    fareCalculation: fareCalculation.replace(/\s*\(/, '.'),
    ...(firstOrigin
      ? { firstOrigin: firstOrigin[1] }
      : null),
    ...(roe
      ? { roe: roe[1] }
      : null)
  };
};

const searchLowFaresValidate = (obj) => {
  // +List, e.g. AirPricePointList, see below
  if (Object.prototype.toString.call(obj['air:AirPricePointList']) !== '[object Object]'
    && Object.prototype.toString.call(obj['air:AirPricingSolution']) !== '[object Object]') {
    throw new AirParsingError.ResponseDataMissing({ missing: 'AirPricePoint or AirPricingSolution' });
  }

  const rootArrays = ['AirSegment', 'FareInfo', 'FlightDetails', 'Route'];

  rootArrays.forEach((name) => {
    const airName = 'air:' + name + 'List';
    if (Object.prototype.toString.call(obj[airName]) !== '[object Object]') {
      throw new AirParsingError.ResponseDataMissing({ missing: airName });
    }
  });

  return obj;
};

const countHistogram = (arr) => {
  const a = {};
  let prev = null;

  if (!Array.isArray(arr)) {
    throw new AirParsingError.HistogramTypeInvalid();
  }

  if (Object.prototype.toString.call(arr[0]) === '[object Object]') {
    arr = arr.map((elem) => elem.Code);
  }

  arr.sort();
  for (let i = 0; i < arr.length; i += 1) {
    if (arr[i] !== prev) {
      a[arr[i]] = 1;
    } else {
      a[arr[i]] += 1;
    }
    prev = arr[i];
  }

  return a;
};

function lowFaresSearchRequest(obj) {
  return format.formatLowFaresSearch({
    debug: false,
    provider: this.provider,
    faresOnly: this.env.faresOnly !== false,
  }, searchLowFaresValidate.call(this, obj));
}

const ticketParse = function (obj) {
  let checkResponseMessage = false;
  let checkTickets = false;

  if (obj['air:TicketFailureInfo']) {
    const { Message, Code } = obj['air:TicketFailureInfo'];
    if (/VALID\sFORM\sOF\sID\s\sFOID\s\sREQUIRED/.exec(Message)) {
      throw new AirRuntimeError.TicketingFoidRequired(obj);
    }
    if (Code === '3979') {
      // The Provider reservation is being modified externally. Please Air Ticket later.
      throw new AirRuntimeError.TicketingPNRBusy(obj);
    }
    if (Code === '12008') {
      if (Message.indexOf('FOP SELECTED NOT AUTHORIZED') !== -1) {
        // Host error during ticket issue. FOP SELECTED NOT AUTHORIZED FOR CARRIER XX
        throw new AirRuntimeError.TicketingFOPUnavailable(obj);
      }

      if (Message.indexOf('REFUSE CREDIT') !== -1) {
        // Host error during ticket issue. REFUSE CREDIT
        throw new AirRuntimeError.TicketingCreditCardRejected(obj);
      }
    }
    throw new AirRuntimeError.TicketingFailed(obj);
  }

  if (obj[`common_${this.uapi_version}:ResponseMessage`]) {
    const responseMessage = obj[`common_${this.uapi_version}:ResponseMessage`];
    responseMessage.forEach((msg) => {
      if (msg._ === 'OK:Ticket issued') {
        checkResponseMessage = true;
      }
    });
  }

  if (checkResponseMessage === false) {
    throw new AirRuntimeError.TicketingResponseMissing(obj);
  }

  if (obj['air:ETR']) {
    try {
      checkTickets = Object.values(obj['air:ETR']).reduce((acc, x) => {
        const tickets = Object.values(x['air:Ticket'] || {})
          .reduce((acc2, t) => !!(acc2 && t.TicketNumber), true);
        return !!(acc && tickets);
      }, true);
    } catch (e) {
      throw new AirRuntimeError.TicketingTicketsMissing(obj);
    }
  }

  return checkResponseMessage && checkTickets;
};

const nullParsing = (obj) => obj;

function fillAirFlightInfoResponseItem(data) {
  const item = data['air:FlightInfoDetail'];
  return {
    from: item.Origin || '',
    to: item.Destination || '',
    departure: item.ScheduledDepartureTime || '',
    arrival: item.ScheduledArrivalTime || '',
    duration: item.TravelTime || '',
    plane: item.Equipment || '',
    fromTerminal: item.OriginTerminal || '',
    toTerminal: item.DestinationTerminal || '',
  };
}

function airFlightInfoRsp(obj) {
  const data = this.mergeLeafRecursive(obj, 'air:FlightInformationRsp')['air:FlightInfo'];

  if (typeof data['air:FlightInfoErrorMessage'] !== 'undefined') {
    switch (data['air:FlightInfoErrorMessage']._) {
      case 'Airline not supported':
        throw new AirFlightInfoRuntimeError.AirlineNotSupported(obj);
      case 'Flight not found':
        throw new AirFlightInfoRuntimeError.FlightNotFound(obj);
      case 'Invalid Flight Number field':
        throw new AirFlightInfoRuntimeError.InvalidFlightNumber(obj);
      default:
        throw new AirFlightInfoRuntimeError(obj);
    }
  }

  if (typeof data.Carrier === 'undefined') {
    const response = [];
    data.forEach((item) => {
      response.push(fillAirFlightInfoResponseItem(item));
    });
    return response;
  }

  return fillAirFlightInfoResponseItem(data);
}

/*
 * returns keys of reservations (AirPricingInfos) with their corresponding passenger
 * category types and counts for an AirPricingSolution
 *
 * NOTE: uses non-parsed input
 */
function airPriceRspPassengersPerReservation(obj) {
  const data = this.mergeLeafRecursive(obj, 'air:AirPriceRsp')['air:AirPriceRsp'];

  const priceResult = data['air:AirPriceResult'];
  const prices = priceResult['air:AirPricingSolution'];
  const priceKeys = Object.keys(prices);

  const pricing = prices[priceKeys[0]]['air:AirPricingInfo'];

  return Object.keys(pricing)
    .reduce((acc, right) => ({
      ...acc,
      [right]: countHistogram(pricing[right]['air:PassengerType']),
    }), {});
}

function airPrice(obj) {
  const priceResult = obj['air:AirPriceResult'];

  const pricingSolutions = priceResult['air:AirPricingSolution'];
  const priceKeys = Object.keys(pricingSolutions);

  let pricingSolution = 0;
  if (priceKeys.length > 1) {
    console.log('More than one solution found in booking. Resolving the cheapest one.');
    const solutions = priceKeys.map((key) => pricingSolutions[key]);

    [pricingSolution] = solutions.sort(
      (a, b) => parseFloat(a.TotalPrice.slice(3)) - parseFloat(b.TotalPrice.slice(3))
    );
  } else {
    pricingSolution = pricingSolutions[priceKeys[0]];
  }

  const pricingInfoKeys = Object.keys(pricingSolution['air:AirPricingInfo']);
  const thisFare = pricingSolution['air:AirPricingInfo'][pricingInfoKeys[0]]; // first get pricing info
  if (!thisFare.PlatingCarrier) {
    throw new AirParsingError.PlatingCarrierNotSet();
  }

  const airSegments = obj['air:AirItinerary']['air:AirSegment'];
  const segments = Object.keys(airSegments).map((segKey) => {
    return obj['air:AirItinerary']['air:AirSegment'][segKey];
  });

  const groups = segments.reduce((previousValue, currentValue) => {
    if (previousValue.indexOf(currentValue.Group) === -1) {
      previousValue.push(currentValue.Group);
    }
    return previousValue;
  }, []);

  /* eslint-disable prefer-const */
  let baggageInfos = [];

  const directions = groups.map((leg) => {
    const segs = segments.filter((value) => {
      return value.Group === leg;
    });

    const trips = segs.map((segment) => {
      const tripFlightDetails = Object.keys(segment['air:FlightDetails'])
        .map((flightDetailsRef) => segment['air:FlightDetails'][flightDetailsRef]);

      const [bookingInfo] = thisFare['air:BookingInfo'].filter((info) => info.SegmentRef === segment.Key);
      const fareInfo = thisFare['air:FareInfo'][bookingInfo.FareInfoRef];

      const baggage = format.getBaggageInfo(thisFare['air:BaggageAllowances']['air:BaggageAllowanceInfo'][leg]);
      baggageInfos.push(baggage);

      return Object.assign(
        format.formatTrip(segment, tripFlightDetails),
        {
          serviceClass: bookingInfo.CabinClass,
          bookingClass: bookingInfo.BookingCode,
          fareBasisCode: fareInfo.FareBasis,
          baggage,
        }
      );
    });

    return [{
      from: trips[0].from,
      to: trips[trips.length - 1].to,
      duration: leg.TravelTime,
      // TODO get overnight stops, etc from connection
      platingCarrier: thisFare.PlatingCarrier,
      segments: trips,
    }];
  });

  const { passengerCounts, passengerFares } = format.formatPassengerCategories(pricingSolution['air:AirPricingInfo']);
  const fareInfo = format.formatFarePricingInfo(thisFare);

  const taxesInfo = thisFare['air:TaxInfo']
    ? Object.keys(thisFare['air:TaxInfo'])
      .map(
        (taxKey) => ({
          value: thisFare['air:TaxInfo'][taxKey].Amount,
          type: thisFare['air:TaxInfo'][taxKey].Category,
          ...(thisFare['air:TaxInfo'][taxKey][`common_${this.uapi_version}:TaxDetail`]
            ? {
              details: thisFare['air:TaxInfo'][taxKey][`common_${this.uapi_version}:TaxDetail`].map(
                (taxDetail) => ({
                  airport: taxDetail.OriginAirport,
                  value: taxDetail.Amount,
                })
              ),
            }
            : null)
        })
      )
    : [];

  return {
    uapi_pricing_info_ref: pricingSolution.Key,
    uapi_pricing_info_group: thisFare.AirPricingInfoGroup,
    farePricingMethod: thisFare.PricingMethod,
    farePricingType: thisFare.PricingType,
    platingCarrier: thisFare.PlatingCarrier,
    totalPrice: pricingSolution.TotalPrice,
    basePrice: pricingSolution.BasePrice,
    equivalentBasePrice: pricingSolution.EquivalentBasePrice,
    taxes: pricingSolution.Taxes,
    directions,
    bookingComponents: [
      {
        totalPrice: thisFare.TotalPrice,
        basePrice: thisFare.BasePrice,
        taxes: thisFare.Taxes,
        uapi_fare_reference: thisFare.Key,
      },
    ],
    passengerCounts,
    passengerFares,
    fareInfo,
    taxesInfo,
    baggage: baggageInfos,
    timeToReprice: thisFare.LatestTicketingTime,
  };
}

function airPriceRspPricingSolutionXML(obj) {
  // first let's parse a regular structure
  const objCopy = JSON.parse(JSON.stringify((obj)));
  const passengersPerReservations = airPriceRspPassengersPerReservation.call(this, objCopy);

  const segments = obj['air:AirPriceRsp'][0]['air:AirItinerary'][0]['air:AirSegment'];
  const priceResult = obj['air:AirPriceRsp'][0]['air:AirPriceResult'][0];
  const pricingSolutions = priceResult['air:AirPricingSolution'];
  let pricingSolution = 0;
  if (pricingSolutions.length > 1) {
    // TODO: Check result for multiple passenger type results.
    console.log('More than one solution found in booking. Resolving the cheapest one.');
    [pricingSolution] = pricingSolutions.sort(
      (a, b) => parseFloat(a.$.TotalPrice.slice(3)) - parseFloat(b.$.TotalPrice.slice(3))
    );
  } else {
    [pricingSolution] = pricingSolutions;
  }

  // remove segment references and add real segments (required)
  delete (pricingSolution['air:AirSegmentRef']);

  pricingSolution['air:AirSegment'] = segments;

  // pricingSolution = moveObjectElement('air:AirSegment', '$', pricingSolution);

  // delete existing air passenger types for each fare (map stored in passengersPerReservations)
  const pricingInfos = pricingSolution['air:AirPricingInfo'].map(
    (info) => ({ ...info, 'air:PassengerType': [] })
  );

  this.env.passengers.forEach((passenger, index) => {
    // find a reservation with places available for this passenger type, decrease counter
    const reservationKey = Object.keys(passengersPerReservations).find((key) => {
      const item = passengersPerReservations[key];
      const { ageCategory } = passenger;
      if (item[ageCategory] > 0) {
        item[ageCategory] -= 1;
        return true;
      }
      return false;
    });

    const pricingInfo = pricingInfos.find((info) => info.$.Key === reservationKey);

    pricingInfo['air:PassengerType'].push({
      $: {
        BookingTravelerRef: 'P_' + index,
        Code: passenger.ageCategory,
        Age: passenger.Age,
      },
    });
  });

  pricingSolution['air:AirPricingInfo'] = pricingInfos;
  const resultXml = {};

  ['air:AirSegment', 'air:AirPricingInfo', 'air:FareNote', `common_${this.uapi_version}:HostToken`].forEach((root) => {
    if (!pricingSolution[root]) {
      return;
    }
    const builder = new xml2js.Builder({
      headless: true,
      rootName: root,
    });

    // workaround because xml2js does not accept arrays to generate multiple "root objects"
    const buildObject = {
      [root]: pricingSolution[root],
    };

    const intResult = builder.buildObject(buildObject);
    // remove root object tags at first and last line
    const lines = intResult.split('\n');
    lines.splice(0, 1);
    lines.splice(-1, 1);

    // return
    resultXml[root + '_XML'] = lines.join('\n');
  });

  const mergedSegments = this.mergeLeafRecursive(objCopy, 'air:AirPriceRsp')['air:AirPriceRsp']['air:AirItinerary']['air:AirSegment'];

  return {
    'air:AirPricingSolution': utils.clone(pricingSolution.$),
    'air:AirPricingSolution_XML': resultXml,
    'air:AirSegment': mergedSegments,
  };
}

function getResponseMessages(source) {
  const responseMessagesKey = `common_${this.uapi_version}:ResponseMessage`;
  return source[responseMessagesKey] || [];
}

function getUAPIErrorMessage(source = {}, fallbackMessage = 'UAPI Service resulted in an error') {
  const {
    faultstring,
    'air:DocumentFailureInfo': documentFailureInfo,
  } = source;
  const responseMessages = getResponseMessages.call(this, source);

  if (source.faultstring) {
    return faultstring;
  }

  if (responseMessages.length > 0) {
    const [responseMessage = {}] = responseMessages;
    const { _: message = fallbackMessage } = responseMessage;

    return message;
  }

  if (documentFailureInfo) {
    const { Message: message = fallbackMessage } = documentFailureInfo;

    return message;
  }

  return null;
}

function processUAPIError(source) {
  const uapiErrorMessage = getUAPIErrorMessage.call(this, source);
  if (!uapiErrorMessage) {
    throw new RequestRuntimeError.UnhandledError(null, new AirRuntimeError(source));
  }

  const pcc = utils.getErrorPcc(uapiErrorMessage);
  const sourceWithFaultString = {
    ...source,
    faultstring: uapiErrorMessage.toUpperCase()
  };

  switch (true) {
    case noAgreementPattern.test(uapiErrorMessage):
      utils.getErrorPcc(uapiErrorMessage);
      throw new AirRuntimeError.NoAgreement({ pcc });
    case unableToRetreivePattern.test(uapiErrorMessage):
      throw new AirRuntimeError.UnableToRetrieve(sourceWithFaultString);
    case ticketRetrieveErrorPattern.test(uapiErrorMessage):
      throw new AirRuntimeError.UnableToRetrieveTicket(sourceWithFaultString);
    case accessedByAnotherTransactionPattern.test(uapiErrorMessage):
      throw new AirRuntimeError.AccessedByAnotherTransaction(sourceWithFaultString);
    default:
      throw new RequestRuntimeError.UAPIServiceError(sourceWithFaultString);
  }
}

const AirErrorHandler = function (rsp) {
  let errorInfo;
  let code;
  let screen;
  try {
    errorInfo = (
      rsp.detail[`common_${this.uapi_version}:ErrorInfo`]
      || rsp.detail['air:AvailabilityErrorInfo']
    );
    code = errorInfo[`common_${this.uapi_version}:Code`];
    screen = errorInfo[`common_${this.uapi_version}:Description`];
  } catch (err) {
    processUAPIError.call(this, rsp);
  }
  const pcc = utils.getErrorPcc(rsp.faultstring);
  switch (code) {
    case '20':
      throw new AirRuntimeError.NoSeatsAvailable(rsp);
    case '345':
    case '1512':
      if (pcc !== null) {
        throw new AirRuntimeError.NoAgreement({ pcc });
      }
      throw new AirRuntimeError.UnableToRetrieve(rsp);
    case '6207': // Error retrieving AccessProfile Unable to retrieve enough Dynamic GTIDs for this transaction
    case '6119': // Host system error
      throw new RequestRuntimeError.UAPIServiceError({ screen });
    case '4454':
      throw new AirRuntimeError.NoResidualValue(rsp);
    case '12009':
      throw new AirRuntimeError.TicketsNotIssued(rsp);
    case '13003':
      throw new AirRuntimeError.NoReservationToImport(rsp);
    case '3003':
      throw new AirRuntimeError.InvalidRequestData(rsp);
    case '3000': {
      if (rsp.faultstring === 'At least one valid locator code or ticket number or tcr number or service fee info should have been specified') {
        throw new AirRuntimeError.TicketInfoIncomplete(rsp);
      }

      const airSegmentErrors = errorInfo['air:AirSegmentError'] || [];
      const messages = airSegmentErrors.map((err) => err['air:ErrorMessage']);

      if (messages.indexOf('Booking is not complete due to waitlisted segment') !== -1) {
        throw new AirRuntimeError.SegmentWaitlisted(rsp);
      }

      // else // unknown error, fall back to SegmentBookingFailed
      throw new AirRuntimeError.SegmentBookingFailed(rsp);
    }
    case '2602': // No Solutions in the response.
    case '3037': // No availability on chosen flights, unable to fare quote
      throw new AirRuntimeError.NoResultsFound(rsp);
    default:
      processUAPIError.call(this, rsp);
  }
};

function getTicketFromEtr(etr, obj, allowNoProviderLocatorCodeRetrieval = false) {
  // Checking if pricing info exists
  if (!allowNoProviderLocatorCodeRetrieval && !etr.ProviderLocatorCode) {
    throw new AirRuntimeError.TicketInfoIncomplete(etr);
  }

  const tourCode = etr.TourCode;

  const passengersList = etr[`common_${this.uapi_version}:BookingTraveler`];
  const passengers = Object.keys(passengersList).map(
    (passengerKey) => {
      const travelerDetails = passengersList[passengerKey][`common_${this.uapi_version}:BookingTravelerName`];
      const firstName = travelerDetails.First.concat(travelerDetails.Prefix || '');
      const lastName = travelerDetails.Last;

      return { firstName, lastName };
    }
  );

  const airPricingInfo = etr['air:AirPricingInfo']
    ? utils.firstInObj(etr['air:AirPricingInfo'])
    : null;

  const fareInfo = airPricingInfo && airPricingInfo['air:FareInfo']
    ? utils.firstInObj(airPricingInfo['air:FareInfo'])
    : null;
  const iataNumber = etr.IATANumber;
  const fopData = etr[`common_${this.uapi_version}:FormOfPayment`]
    ? Object.values(etr[`common_${this.uapi_version}:FormOfPayment`])
    : [];
  const ccAuthData = etr[`common_${this.uapi_version}:CreditCardAuth`]
    ? etr[`common_${this.uapi_version}:CreditCardAuth`]
    : [];
  const formOfPayment = fopData.map((fop) => {
    return fop.Type === 'Credit'
      ? utils.getCreditCardData(fop[`common_${this.uapi_version}:CreditCard`], ccAuthData)
      : fop.Type.toUpperCase();
  });
  const ticketsList = Object.values(etr['air:Ticket']);
  const exchangedTickets = [];

  const allCoupons = ticketsList.map((ticket) => {
    return Object.entries(ticket['air:Coupon']).map(([couponKey, coupon]) => {
      return {
        key: couponKey,
        ticketNumber: ticket.TicketNumber,
        couponNumber: coupon.CouponNumber,
        from: coupon.Origin,
        to: coupon.Destination,
        departure: coupon.DepartureTime,
        airline: coupon.MarketingCarrier,
        flightNumber: coupon.MarketingFlightNumber,
        fareBasisCode: utils.formFareBasisCode(airPricingInfo, coupon),
        status: coupon.Status,
        notValidBefore: coupon.NotValidBefore,
        notValidAfter: coupon.NotValidAfter,
        bookingClass: coupon.BookingClass,
        stopover: coupon.StopoverCode === 'true',
      };
    });
  }).reduce((all, nextChunk) => {
    return all.concat(nextChunk);
  }, []);

  const tickets = ticketsList.map(
    (ticket) => {
      if (ticket['air:ExchangedTicketInfo']) {
        ticket['air:ExchangedTicketInfo'].forEach(
          (t) => exchangedTickets.push(t.Number)
        );
      }

      const coupons = Object.keys(ticket['air:Coupon']).map(
        (couponKey) => {
          const allCouponsIndex = allCoupons.findIndex((ac) => ac.key === couponKey);
          const coupon = allCoupons[allCouponsIndex];
          const nextCoupon = allCoupons[allCouponsIndex + 1];

          let bookingInfo = null;
          // looking for fareInfo by it's fareBasis
          // and for bookingInfo by correct FareInfoRef
          if (airPricingInfo && airPricingInfo['air:FareInfo']) {
            Object.keys(airPricingInfo['air:FareInfo']).forEach(
              (fareKey) => {
                const fare = airPricingInfo['air:FareInfo'][fareKey];
                if (fare.FareBasis === coupon.FareBasis
                  && airPricingInfo['air:BookingInfo']) {
                  const bInfo = airPricingInfo['air:BookingInfo'].find(
                    (info) => info.FareInfoRef === fareKey
                  );

                  if (bInfo) {
                    bookingInfo = bInfo;
                  }
                }
              }
            );
          }

          return {
            ...coupon,
            stopover: (
              nextCoupon
                ? nextCoupon.stopover
                : true
            ),
            ...(bookingInfo !== null ? { serviceClass: bookingInfo.CabinClass } : null)
          };
        }
      );

      return {
        ticketNumber: ticket.TicketNumber,
        coupons,
      };
    }
  );

  const taxes = (airPricingInfo && airPricingInfo['air:TaxInfo'])
    ? Object.keys(airPricingInfo['air:TaxInfo']).map(
      (taxKey) => ({
        type: airPricingInfo['air:TaxInfo'][taxKey].Category,
        value: airPricingInfo['air:TaxInfo'][taxKey].Amount,
        ...(airPricingInfo['air:TaxInfo'][taxKey][`common_${this.uapi_version}:TaxDetail`]
          ? {
            details: airPricingInfo['air:TaxInfo'][taxKey][`common_${this.uapi_version}:TaxDetail`].map(
              (taxDetail) => ({
                airport: taxDetail.OriginAirport,
                value: taxDetail.Amount,
              })
            ),
          }
          : null)
      })
    )
    : [];
  const priceSource = airPricingInfo || etr;
  const priceInfoAvailable = priceSource.BasePrice !== undefined;

  const commission = (etr && etr[`common_${this.uapi_version}:Commission`])
    || (fareInfo && fareInfo[`common_${this.uapi_version}:Commission`])
    || null;

  const fareCalcSource = etr['air:FareCalc'].match(fareCalculationPattern)
    ? etr['air:FareCalc']
    : airPricingInfo['air:FareCalc'];
  const response = {
    uapi_ur_locator: obj.UniversalRecordLocatorCode,
    uapi_reservation_locator: etr['air:AirReservationLocatorCode'],
    pnr: etr.ProviderLocatorCode,
    ticketNumber: tickets[0].ticketNumber,
    platingCarrier: etr.PlatingCarrier,
    ticketingPcc: etr.PseudoCityCode,
    issuedAt: etr.IssuedDate,
    farePricingMethod: airPricingInfo ? airPricingInfo.PricingMethod : null,
    farePricingType: airPricingInfo ? airPricingInfo.PricingType : null,
    priceInfoAvailable,
    priceInfoDetailsAvailable: (airPricingInfo !== null),
    taxes: priceSource.Taxes,
    taxesInfo: taxes,
    passengers,
    tickets,
    iataNumber,
    formOfPayment,
    // Flags
    noAdc: !etr.TotalPrice,
    isConjunctionTicket: tickets.length > 1,
    tourCode,
    ...parseFareCalculation(fareCalcSource),
    ...(commission
      ? {
        commission: {
          type: commission.Type === 'PercentBase' ? 'Z' : 'ZA',
          value: commission.Type === 'PercentBase'
            ? parseFloat(commission.Percentage)
            : parseFloat(commission.Amount.slice(3))
        },
      }
      : null),
    ...(priceInfoAvailable
      ? {
        totalPrice: priceSource.TotalPrice
        || `${(priceSource.EquivalentBasePrice || priceSource.BasePrice).slice(0, 3)}0`,
        basePrice: priceSource.BasePrice,
        equivalentBasePrice: priceSource.EquivalentBasePrice,
      }
      : null),
    ...(exchangedTickets.length > 0
      ? { exchangedTickets }
      : null)
  };

  return response;
}

const airGetTicket = function (obj, parseParams = {
  allowNoProviderLocatorCodeRetrieval: false
}) {
  const failure = obj['air:DocumentFailureInfo'];
  const responseMessages = getResponseMessages.call(this, obj);

  if (failure) {
    if (failure.Code === '3273') {
      throw new AirRuntimeError.DuplicateTicketFound(obj);
    }

    processUAPIError.call(this, obj, 'Unable to retrieve ticket');
  }

  if (responseMessages.some(({ Type, Code }) => (Type === 'Error' && Code !== '12009'))) {
    processUAPIError.call(this, obj, 'Unable to retrieve ticket');
  }

  const etr = obj['air:ETR'];

  if (!etr) {
    processUAPIError.call(this, obj, 'Unable to retrieve ticket');
  }

  const multipleTickets = !!etr[Object.keys(etr)[0]].ProviderLocatorCode;

  if (multipleTickets) {
    return Object.values(etr)
      .map((innerEtr) => (
        getTicketFromEtr.call(this, innerEtr, obj, parseParams.allowNoProviderLocatorCodeRetrieval)
      ));
  }

  return getTicketFromEtr.call(this, etr, obj, parseParams.allowNoProviderLocatorCodeRetrieval);
};

const responseHasNoTickets = (rsp) => (
  rsp.faultcode !== undefined
  && rsp.faultstring !== undefined
  && /has no tickets/.test(rsp.faultstring)
);

function airGetTicketsErrorHandler(rsp) {
  let errorInfo;
  let code;
  try {
    errorInfo = (
      rsp.detail[`common_${this.uapi_version}:ErrorInfo`]
      || rsp.detail['air:AvailabilityErrorInfo']
    );
    code = errorInfo[`common_${this.uapi_version}:Code`];
  } catch (err) {
    processUAPIError.call(this, rsp);
  }
  // General Air Service error
  if (code === '3000') {
    if (responseHasNoTickets(rsp)) {
      return rsp;
    }
  }
  switch (code) {
    case '345':
      throw new AirRuntimeError.NoAgreement({
        pcc: utils.getErrorPcc(rsp.faultstring),
      });
    default:
      return processUAPIError.call(this, rsp);
  }
}

function airGetTickets(obj) {
  // No tickets in PNR
  if (responseHasNoTickets(obj)) {
    return [];
  }
  // Parsing response
  const tickets = airGetTicket.call(this, obj);
  return Array.isArray(tickets)
    ? tickets
    : [tickets];
}

function airCancelTicket(obj) {
  if (
    !obj['air:VoidResultInfo']
    || obj['air:VoidResultInfo'].ResultType !== 'Success'
  ) {
    throw new AirRuntimeError.TicketCancelResultUnknown(obj);
  }
  return true;
}

function airCancelPnr(obj) {
  const messages = obj[`common_${this.uapi_version}:ResponseMessage`] || [];
  if (
    messages.some(
      (message) => message._ === 'Itinerary Cancelled'
    )
  ) {
    return true;
  }
  throw new AirParsingError.CancelResponseNotFound();
}

function formSupplierLocatorBlock(supplierLocator) {
  return supplierLocator.map((info) => ({
    createDate: info.CreateDateTime,
    supplierCode: info.SupplierCode,
    locatorCode: info.SupplierLocatorCode,
  }));
}

function extractBookings(obj) {
  const record = obj['universal:UniversalRecord'];
  const messages = obj[`common_${this.uapi_version}:ResponseMessage`] || [];

  messages.forEach(({ _, Code }) => {
    if (noValidFare.exec(_)) {
      throw new AirRuntimeError.NoValidFare(obj);
    }

    if (bookingStaleData.exec(_) || Code === BOOKING_STALE_DATA_ERROR_CODE) {
      throw new AirRuntimeError.UniversalRecordDataCouldBeStale(messages);
    }
  });

  if (obj['air:AirSegmentSellFailureInfo']) {
    throw new AirRuntimeError.SegmentBookingFailed(obj);
  }

  const travelers = record['common_' + this.uapi_version + ':BookingTraveler'];
  const hasTravelers = !!travelers && !!Object.keys(travelers).length;
  const hasAirReservation = Array.isArray(record['air:AirReservation']) && !!record['air:AirReservation'].length;

  if (!hasTravelers && !hasAirReservation) {
    throw new AirParsingError.ReservationsMissing();
  }

  const reservationInfo = record['universal:ProviderReservationInfo'];
  const remarksObj = record[`common_${this.uapi_version}:GeneralRemark`];
  const remarks = remarksObj
    ? Object.keys(remarksObj)
      .reduce(
        (acc, key) => {
          const reservationRef = remarksObj[key].ProviderReservationInfoRef;
          return Object.assign(
            acc,
            {
              [reservationRef]: (acc[reservationRef] || []).concat(remarksObj[key]),
            }
          );
        },
        {}
      )
    : {};

  if (!hasAirReservation) {
    return Object.keys(reservationInfo).map((key) => {
      const providerInfo = reservationInfo[key];
      const passengers = Object.keys(record[`common_${this.uapi_version}:BookingTraveler`]).map((travelerKey) => {
        const traveler = record[`common_${this.uapi_version}:BookingTraveler`][travelerKey];
        const name = traveler[`common_${this.uapi_version}:BookingTravelerName`];

        return format.buildPassenger(name, traveler);
      });

      return {
        type: 'uAPI',
        pnr: reservationInfo[key].LocatorCode,
        version: Number(record.Version),
        uapi_ur_locator: record.LocatorCode,
        createdAt: providerInfo.CreateDate,
        hostCreatedAt: providerInfo.HostCreateDate,
        modifiedAt: providerInfo.ModifiedDate,
        fareQuotes: [],
        segments: [],
        serviceSegments: [],
        passengers,
        emails: [],
        bookingPCC: providerInfo.OwningPCC,
        ...(messages ? { messages } : null),
      };
    });
  }

  return record['air:AirReservation'].map((booking) => {
    const resKey = `common_${this.uapi_version}:ProviderReservationInfoRef`;
    const providerInfo = reservationInfo[booking[resKey]];
    const ticketingModifiers = booking['air:TicketingModifiers'];
    const emails = [];
    const providerInfoKey = providerInfo.Key;
    const resRemarks = remarks[providerInfoKey] || [];
    const splitBookings = (
      providerInfo['universal:ProviderReservationDetails']
      && providerInfo['universal:ProviderReservationDetails'].DivideDetails === 'true'
    )
      ? resRemarks.reduce(
        (acc, remark) => {
          const splitMatch = remark[`common_${this.uapi_version}:RemarkData`].match(/^SPLIT\s.*([A-Z0-9]{6})$/);
          if (!splitMatch) {
            return acc;
          }
          return acc.concat(splitMatch[1]);
        },
        []
      )
      : [];

    const passiveReservation = record['passive:PassiveReservation']
      ? record['passive:PassiveReservation'].find((res) => res.ProviderReservationInfoRef === providerInfoKey)
      : null;

    if (!providerInfo) {
      throw new AirParsingError.ReservationProviderInfoMissing();
    }

    const passengers = booking[`common_${this.uapi_version}:BookingTravelerRef`].map(
      (travellerRef) => {
        const traveler = travelers[travellerRef];
        if (!traveler) {
          throw new AirRuntimeError.TravelersListError();
        }
        const name = traveler[`common_${this.uapi_version}:BookingTravelerName`];
        const travelerEmails = traveler[`common_${this.uapi_version}:Email`];
        if (travelerEmails) {
          Object.keys(travelerEmails).forEach(
            (i) => {
              const email = travelerEmails[i];
              const { Type: type = 'To' } = email;

              if (
                email[`common_${this.uapi_version}:ProviderReservationInfoRef`]
                && type.toUpperCase() === 'TO'
              ) {
                emails.push({
                  index: emails.length + 1,
                  email: email.EmailID.toLowerCase(),
                });
              }
            }
          );
        }

        return format.buildPassenger(name, traveler);
      }
    );

    const {
      segments: indexedSegments,
      serviceSegments: indexedServiceSegments,
    } = format.setIndexesForSegments(
      booking['air:AirSegment'] || null,
      (passiveReservation && passiveReservation['passive:PassiveSegment']) || null
    );

    const supplierLocator = booking[`common_${this.uapi_version}:SupplierLocator`] || [];
    const segments = indexedSegments
      ? indexedSegments.map((segment) => ({
        ...format.formatTrip(segment, segment['air:FlightDetails']),
        index: segment.index,
        status: segment.Status,
        serviceClass: segment.CabinClass,
        bookingClass: segment.ClassOfService,
      }))
      : [];

    const serviceSegments = indexedServiceSegments
      ? indexedServiceSegments.map((s) => {
        const remark = passiveReservation['passive:PassiveRemark'].find(
          (r) => r.PassiveSegmentRef === s.Key
        );

        try {
          return format.formatServiceSegment(s, remark);
        } catch (e) {
          console.warn(`PassiveRemark is not service segment: ${remark['passive:Text']}.`);

          return null;
        }
      }).filter((v) => v)
      : [];

    const fareQuotesCommon = {};
    const tickets = (booking['air:DocumentInfo'] && booking['air:DocumentInfo']['air:TicketInfo']) ? (
      booking['air:DocumentInfo']['air:TicketInfo'].map(
        (ticket) => ({
          number: ticket.Number,
          passengers: [{
            firstName: ticket[`common_${this.uapi_version}:Name`].First,
            lastName: ticket[`common_${this.uapi_version}:Name`].Last,
          }],
          uapi_passenger_ref: ticket.BookingTravelerRef,
          uapi_pricing_info_ref: (ticket.AirPricingInfoRef)
            ? ticket.AirPricingInfoRef
            : null,
        })
      )
    ) : [];

    const pricingInfos = !booking['air:AirPricingInfo']
      ? []
      : Object.keys(booking['air:AirPricingInfo']).map(
        (key) => {
          const pricingInfo = booking['air:AirPricingInfo'][key];

          const uapiSegmentRefs = (pricingInfo['air:BookingInfo'] || []).map(
            (segment) => segment.SegmentRef
          );

          const uapiPassengerRefs = pricingInfo[`common_${this.uapi_version}:BookingTravelerRef`];

          const fareInfo = pricingInfo['air:FareInfo'];

          const baggage = fareInfo && Object.keys(fareInfo).map(
            (fareLegKey) => format.getBaggage(fareInfo[fareLegKey]['air:BaggageAllowance'])
          );

          const passengersCount = (pricingInfo['air:PassengerType'] || [])
            .reduce((acc, data) => Object.assign(acc, {
              [data.Code]: (acc[data.Code] || 0) + 1,
            }), {});

          const taxesInfo = pricingInfo['air:TaxInfo']
            ? Object.keys(pricingInfo['air:TaxInfo']).map(
              (taxKey) => ({
                value: pricingInfo['air:TaxInfo'][taxKey].Amount,
                type: pricingInfo['air:TaxInfo'][taxKey].Category,
                ...(pricingInfo['air:TaxInfo'][taxKey][`common_${this.uapi_version}:TaxDetail`]
                  ? {
                    details: pricingInfo['air:TaxInfo'][taxKey][`common_${this.uapi_version}:TaxDetail`].map(
                      (taxDetail) => ({
                        airport: taxDetail.OriginAirport,
                        value: taxDetail.Amount,
                      })
                    ),
                  }
                  : null)
              })
            )
            : [];

          const modifierKey = pricingInfo['air:TicketingModifiersRef']
            ? Object.keys(pricingInfo['air:TicketingModifiersRef'])[0]
            : null;

          const modifiers = modifierKey && ticketingModifiers[modifierKey];

          const platingCarrier = modifiers
            ? modifiers.PlatingCarrier
            : null;

          const firstFareInfo = utils.firstInObj(fareInfo);

          const tourCode = fareInfo && (firstFareInfo.TourCode || null);

          const endorsement = fareInfo && firstFareInfo[`common_${this.uapi_version}:Endorsement`]
            ? firstFareInfo[`common_${this.uapi_version}:Endorsement`]
              .map((end) => end.Value)
              .join(' ')
            : null;

          fareQuotesCommon[pricingInfo.AirPricingInfoGroup] = {
            uapi_segment_refs: uapiSegmentRefs,
            effectiveDate: fareInfo && firstFareInfo.EffectiveDate,
            endorsement,
            tourCode,
            ...(platingCarrier
              ? { platingCarrier }
              : null)
          };

          const pricingInfoPassengers = (uapiPassengerRefs || []).map(
            (ref) => {
              const ticket = tickets.find(
                (t) => t.uapi_passenger_ref === ref && t.uapi_pricing_info_ref === key
              );
              return {
                uapi_passenger_ref: ref,
                isTicketed: !!ticket,
                ...(ticket
                  ? { ticketNumber: ticket.number }
                  : null)
              };
            }
          );

          return {
            uapi_pricing_info_ref: key,
            passengers: pricingInfoPassengers,
            uapi_pricing_info_group: pricingInfo.AirPricingInfoGroup,
            farePricingMethod: pricingInfo.PricingMethod,
            farePricingType: pricingInfo.PricingType,
            totalPrice: pricingInfo.TotalPrice,
            basePrice: pricingInfo.BasePrice,
            equivalentBasePrice: pricingInfo.EquivalentBasePrice,
            taxes: pricingInfo.Taxes,
            passengersCount,
            taxesInfo,
            baggage,
            timeToReprice: pricingInfo.LatestTicketingTime,
            ...parseFareCalculation(pricingInfo['air:FareCalc'])
          };
        }
      ).filter(Boolean);

    const fareQuotesGrouped = pricingInfos.reduce((acc, pricingInfo) => Object.assign(acc, {
      [pricingInfo.uapi_pricing_info_group]: (acc[pricingInfo.uapi_pricing_info_group] || [])
        .concat(pricingInfo),
    }), {});

    const fareQuotes = Object.keys(fareQuotesGrouped).map((key) => {
      const fqGroup = fareQuotesGrouped[key];
      const fqGroupPassengers = fqGroup.reduce(
        (acc, fq) => acc.concat(
          fq.passengers.map((p) => p.uapi_passenger_ref)
        ),
        []
      );

      return {
        pricingInfos: fqGroup,
        uapi_passenger_refs: fqGroupPassengers,
        ...fareQuotesCommon[key],
      };
    }).sort(
      (fq1, fq2) => moment(fq1.effectiveDate) - moment(fq2.effectiveDate)
    ).map(
      (fq, index) => ({ ...fq, index: index + 1 })
    );

    return {
      type: 'uAPI',
      pnr: providerInfo.LocatorCode,
      version: Number(record.Version),
      uapi_ur_locator: record.LocatorCode,
      uapi_reservation_locator: booking.LocatorCode,
      airlineLocatorInfo: formSupplierLocatorBlock(supplierLocator),
      createdAt: providerInfo.CreateDate,
      hostCreatedAt: providerInfo.HostCreateDate,
      modifiedAt: providerInfo.ModifiedDate,
      fareQuotes,
      segments: format.setReferencesForSegments(segments),
      serviceSegments,
      passengers,
      emails,
      bookingPCC: providerInfo.OwningPCC,
      tickets,
      ...(splitBookings.length > 0
        ? { splitBookings }
        : null),
      ...(messages ? { messages } : null)
    };
  });
}

function importRequest(data) {
  const response = extractBookings.call(this, data);
  return response;
}

function universalRecordRetrieveRequest(data) {
  const response = extractBookings.call(this, data);
  return response;
}

function extractFareRules(obj) {
  const rulesList = obj['air:FareRule'];
  rulesList.forEach((item) => {
    const result = [];
    const listName = (item['air:FareRuleLong']) ? 'air:FareRuleLong' : 'air:FareRuleShort';
    item[listName].forEach((rule) => {
      const ruleCategoryNumber = parseInt(rule.Category, 10);
      if (rule['air:FareRuleNameValue']) {
        // for short rules
        result[ruleCategoryNumber] = rule['air:FareRuleNameValue'];
      } else {
        // for long rules
        result[ruleCategoryNumber] = rule._;
      }
    });

    delete item[listName];
    delete item.FareInfoRef;
    item.Rules = result;
  });

  return rulesList;
}

function airPriceFareRules(data) {
  return extractFareRules(data['air:AirPriceResult']);
}

function gdsQueue(req) {
  // TODO implement all major error cases
  // https://support.travelport.com/webhelp/uapi/uAPI.htm#Error_Codes/QUESVC_Service_Error_Codes.htm%3FTocPath%3DError%2520Codes%2520and%2520Messages|_____9
  // like 7015 "Branch does not have Queueing configured"

  let data = null;
  try {
    [data] = req[`common_${this.uapi_version}:ResponseMessage`];
  } catch (e) {
    throw new GdsRuntimeError.PlacingInQueueError(req);
  }

  // TODO check if there can be several messages
  const message = data._;
  if (message.match(/^Booking successfully placed/) === null) {
    throw new GdsRuntimeError.PlacingInQueueMessageMissing(message);
  }

  return true;
}

function exchangeQuote(req) {
  const root = 'air:AirExchangeQuoteRsp';
  const xml = req[root][0];
  const tokenRoot = `common_${this.uapi_version}:HostToken`;

  const token = {
    'air:AirExchangeBundle': xml['air:AirExchangeBundle'],
    'air:AirPricingSolution': xml['air:AirPricingSolution'],
    [tokenRoot]: xml[tokenRoot],
  };

  return utils.deflate(JSON.stringify(token))
    .then((zippedToken) => {
      const json = this.mergeLeafRecursive(req, root)['air:AirExchangeQuoteRsp'];

      const exchangeInfoRoot = `common_${this.uapi_version}:AirExchangeInfo`;

      const exchangeBundleTotal = json['air:AirExchangeBundleTotal'];
      const totalBundle = exchangeBundleTotal
        && exchangeBundleTotal[exchangeInfoRoot];

      const exchangeDetails = json['air:AirExchangeBundle'].map((bundle) => {
        const exchange = bundle[exchangeInfoRoot];
        const taxes = exchange[`common_${this.uapi_version}:PaidTax`]
          .map((tax) => ({ type: tax.Code, value: tax.Amount }));

        return {
          ...format.formatAirExchangeBundle(exchange),
          taxes,
          uapi_pricing_info_ref: Object.keys(bundle['air:AirPricingInfoRef'])[0],
        };
      });

      const solution = utils.firstInObj(json['air:AirPricingSolution']);
      const segments = Object.keys(solution['air:AirSegment']).map((key) => {
        const segment = solution['air:AirSegment'][key];
        return {
          ...format.formatSegment(segment),
          serviceClass: segment.CabinClass,
          bookingClass: segment.ClassOfService,
        };
      });

      const pricingInfo = Object.keys(solution['air:AirPricingInfo'])
        .map((key) => {
          const pricing = solution['air:AirPricingInfo'][key];

          const bookingInfo = Object.keys(pricing['air:BookingInfo'])
            .map((bookingInfoKey) => {
              const info = pricing['air:BookingInfo'][bookingInfoKey];
              const fare = pricing['air:FareInfo'][info.FareInfoRef];

              return {
                bookingCode: info.BookingCode,
                cabinClass: info.CabinClass,
                baggage: format.getBaggage(fare['air:BaggageAllowance']),
                fareBasis: fare.FareBasis,
                from: fare.Origin,
                to: fare.Destination,
                uapi_segment_ref: info.SegmentRef,
              };
            });

          return {
            ...format.formatPrices(pricing),
            bookingInfo,
            uapi_pricing_info_ref: pricing.Key,
            ...parseFareCalculation(pricing['air:FareCalc'])
          };
        });

      const airPricingDetails = solution['air:PricingDetails'];

      return {
        exchangeToken: zippedToken,
        exchangeDetails,
        segments,
        pricingInfo,
        pricingDetails: {
          pricingType: airPricingDetails.PricingType,
          lowFareFound: airPricingDetails.LowFareFound === 'true',
          lowFarePricing: airPricingDetails.LowFarePricing === 'true',
          discountApplies: airPricingDetails.DiscountApplies === 'true',
          penaltyApplies: airPricingDetails.DiscountApplies === 'true',
          conversionRate: parseFloat(airPricingDetails.ConversionRate || 1),
          rateOfExchange: parseFloat(airPricingDetails.RateOfExchange || 1),
          validatingVendor: airPricingDetails.ValidatingVendorCode,
        },
        pricingSolution: format.formatPrices(solution),
        exchangeTotal: {
          ...format.formatAirExchangeBundle(totalBundle),
          pricingTag: totalBundle.PricingTag,
        },
      };
    });
}

function exchangeBooking(rsp) {
  if (rsp['air:AirReservation']) {
    return true;
  }
  throw new AirRuntimeError.CantDetectExchangeResponse(rsp);
}

function availability(rsp) {
  const itinerarySolution = utils.firstInObj(rsp['air:AirItinerarySolution']);

  const connectedSegments = itinerarySolution['air:Connection']
    ? itinerarySolution['air:Connection'].map(
      (s) => parseInt(s.SegmentIndex, 10)
    )
    : [];

  const results = [];
  let leg = [];
  itinerarySolution['air:AirSegmentRef'].forEach((segmentRef, key) => {
    const segment = rsp['air:AirSegmentList'][segmentRef];
    const isConnected = connectedSegments.find((s) => s === key);
    const availInfoList = segment['air:AirAvailInfo'] || [];
    const availInfo = availInfoList.find((info) => info.ProviderCode === this.provider);

    if (!availInfo) {
      return;
    }

    if (!availInfo['air:BookingCodeInfo']) {
      return;
    }

    const cabinsAvailability = availInfo['air:BookingCodeInfo']
      .filter((info) => {
        if (this.env.cabins && this.env.cabins.length > 0) {
          return this.env.cabins.indexOf(info.CabinClass) !== -1;
        }

        return true;
      })
      .reduce((acc, x) => {
        const codes = x.BookingCounts
          .split('|')
          .map((item) => ({
            bookingClass: item[0],
            cabin: x.CabinClass,
            seats: item[1].trim(),
          }));

        return acc.concat(codes);
      }, []);

    const s = {
      ...format.formatSegment(segment),
      plane: segment.Equipment,
      duration: segment.FlightTime,
      availability: cabinsAvailability,
    };

    leg.push(s);

    if (isConnected === undefined) {
      results.push(leg);
      leg = [];
    }
  });

  if (leg.length !== 0) {
    results.push(leg);
  }

  return {
    legs: results,
    nextResultReference: rsp[`common_${this.uapi_version}:NextResultReference`] || null,
  };
}

function formCouponsBlock(coupons) {
  return Object.values(coupons).map((coupon) => {
    return {
      uapi_emd_coupon_ref: coupon.Key,
      number: parseInt(coupon.Number, 10),
      status: coupon.Status,
      svcDesc: coupon.SvcDescription,
      consumedAtIssuanceInd: coupon.ConsumedAtIssuanceInd === 'true',
      rfiCode: coupon.RFIC,
      rfiSubcode: coupon.RFISC,
      rfiDesc: coupon.RFIDescription,
      origin: coupon.Origin,
      destination: coupon.Destination,
      flightNumber: coupon.FlightNumber,
      isRefundable: coupon.NonRefundableInd !== 'true',
    };
  });
}

function formPassengerBlock(passenger) {
  return {
    lastName: passenger['air:NameInfo'].Last,
    firstName: passenger['air:NameInfo'].First,
    ageCategory: passenger.TravelerType,
    age: passenger.Age,
  };
}

function getEMDListItem(obj) {
  const passenger = obj['air:EMDTravelerInfo'];
  const summary = obj['air:EMDSummary'];

  return {
    summary: {
      coupons: formCouponsBlock(summary['air:EMDCoupon']),
      uapi_emd_ref: summary.Key,
      number: summary.Number,
      isPrimaryDocument: summary.PrimaryDocumentIndicator === 'true',
      associatedTicket: summary.AssociatedTicketNumber,
      platingCarrier: summary.PlatingCarrier,
      issuedAt: summary.IssueDate,
    },
    passenger: formPassengerBlock(passenger)
  };
}

function getEMDList(obj) {
  const eMDSummaryInfo = obj['air:EMDSummaryInfo'];

  if (!eMDSummaryInfo) {
    processUAPIError.call(this, obj, 'Unable to retrieve EMD list');
  }

  return Object.values(eMDSummaryInfo).map((val) => (getEMDListItem.call(this, val)));
}

function getEMDItem(obj) {
  const emdInfo = obj['air:EMDInfo'];

  const passenger = emdInfo['air:EMDTravelerInfo'];
  const supplierLocator = emdInfo[`common_${this.uapi_version}:SupplierLocator`] || [];
  const emd = emdInfo['air:ElectronicMiscDocument'];
  const payment = Object.values(emdInfo[`common_${this.uapi_version}:Payment`]).map((item) => {
    return {
      uapi_payment_ref: item.Key,
      type: item.Type,
      amount: item.Amount,
      uapi_fop_ref: item.FormOfPaymentRef,
    };
  });
  const fop = Object.values(emdInfo[`common_${this.uapi_version}:FormOfPayment`]).map((item) => {
    return {
      uapi_fop_ref: item.Key,
      type: item.Type,
      reusable: item.Reusable === 'true',
      profileKey: item.ProfileKey,
    };
  });
  const pricingInfo = emdInfo['air:EMDPricingInfo'];

  return {
    passenger: formPassengerBlock(passenger),
    airlineLocatorInfo: formSupplierLocatorBlock(supplierLocator),
    details: {
      coupons: formCouponsBlock(emd['air:EMDCoupon']),
      uapi_emd_ref: emd.Key,
      issuedAt: emd.IssueDate,
      number: emd.Number,
      status: emd.Status,
      isPrimaryDocument: emd.PrimaryDocumentIndicator === 'true',
      associatedTicket: emd.AssociatedTicketNumber,
      platingCarrier: emd.PlatingCarrier,
    },
    payment,
    fop,
    pricingInfo: {
      taxInfo: pricingInfo['air:TaxInfo'] ? {
        amount: pricingInfo['air:TaxInfo'].Amount,
        category: pricingInfo['air:TaxInfo'].Category,
      } : undefined,
      baseFare: pricingInfo.BaseFare,
      totalFare: pricingInfo.TotalFare,
      totalTax: pricingInfo.TotalTax,
    },
    uapi_emd_ref: emdInfo.Key,
    pnr: emdInfo.ProviderLocatorCode,
  };
}

module.exports = {
  AIR_LOW_FARE_SEARCH_REQUEST: lowFaresSearchRequest,
  AIR_PRICE_REQUEST: airPrice,
  AIR_PRICE_REQUEST_PRICING_SOLUTION_XML: airPriceRspPricingSolutionXML,
  AIR_PRICE_FARE_RULES_REQUEST: airPriceFareRules,
  AIR_CREATE_RESERVATION_REQUEST: extractBookings,
  AIR_TICKET_REQUEST: ticketParse,
  AIR_IMPORT_REQUEST: importRequest,
  UNIVERSAL_RECORD_RETRIEVE_REQUEST: universalRecordRetrieveRequest,
  GDS_QUEUE_PLACE_RESPONSE: gdsQueue,
  AIR_CANCEL_UR: nullParsing,
  UNIVERSAL_RECORD_FOID: nullParsing,
  UNIVERSAL_RECORD_MODIFY: nullParsing,
  AIR_ERRORS: AirErrorHandler, // errors handling
  AIR_FLIGHT_INFORMATION: airFlightInfoRsp,
  AIR_GET_TICKET: airGetTicket,
  AIR_GET_TICKETS: airGetTickets,
  AIR_GET_TICKETS_ERROR_HANDLER: airGetTicketsErrorHandler,
  AIR_CANCEL_TICKET: airCancelTicket,
  AIR_CANCEL_PNR: airCancelPnr,
  AIR_EXCHANGE_QUOTE: exchangeQuote,
  AIR_EXCHANGE: exchangeBooking,
  AIR_AVAILABILITY: availability,
  AIR_EMD_LIST: getEMDList,
  AIR_EMD_ITEM: getEMDItem,
};
