const fs = require('fs');
const path = require('path');
const chai = require('chai');
const proxyquire = require('proxyquire');
const sinon = require('sinon');
const sinonChai = require('sinon-chai');
const assert = require('assert');
const moment = require('moment');
const auth = require('../testconfig');
const { AirRuntimeError } = require('../../src/Services/Air/AirErrors');
const { RequestSoapError } = require('../../src/Request/RequestErrors');

const { expect } = chai;
chai.use(sinonChai);

const responsesDir = path.join(__dirname, '..', 'FakeResponses', 'Air');
const terminalResponsesDir = path.join(__dirname, '..', 'FakeResponses', 'Terminal');

const getAirServiceMock = ({ methods = {}, options = {} }) => {
  const createAirService = proxyquire('../../src/Services/Air/Air', {
    './AirService': () => ({ ...methods }),
  });

  return createAirService({ auth, ...options });
};

describe('#AirService', () => {
  const getURByPNRSampleBooked = [
    {
      pnr: 'PNR002',
    }, {
      pnr: 'PNR001',
    },
  ];
  const getURbyPNRSampleTicketed = [
    {
      pnr: 'PNR001',
      uapi_ur_locator: 'UAPI01',
      uapi_reservation_locator: 'ABCDEF',
      ticketNumber: 123,
      tickets: [
        { number: '1234567890123' },
        { number: '1234567890456' },
      ],
    },
  ];
  const fq = {
    pricingInfos: [{
      totalPrice: 'UAH10',
    },
    {
      totalPrice: 'UAH11',
    }]
  };
  const getURbyPNRSampleWithCurrency = getURbyPNRSampleTicketed.map(booking => ({
    ...booking,
    fareQuotes: [fq, fq]
  }));
  const getURbyPNRSampleTicketedWithEmptyTickets = [
    {
      pnr: 'PNR001',
      uapi_ur_locator: 'UAPI01',
      uapi_reservation_locator: 'ABCDEF',
      ticketNumber: 123,
      tickets: [],
    },
  ];

  describe('shop', () => {
    it('should check if correct function from service is called', () => {
      const searchLowFares = sinon.spy(() => {});
      const air = getAirServiceMock({ methods: { searchLowFares } });
      air.shop({});
      expect(searchLowFares.calledOnce).to.be.equal(true);
    });

    it('should check if correct function from service is called with async option', () => {
      const searchLowFaresAsync = sinon.spy(() => {});
      const air = getAirServiceMock({ methods: { searchLowFaresAsync } });
      air.shop({ async: true });
      expect(searchLowFaresAsync.calledOnce).to.be.equal(true);
    });
  });

  describe('retrieveShop', () => {
    it('should check if correct function from service is called', () => {
      const searchLowFaresRetrieve = sinon.spy(() => {});
      const air = getAirServiceMock({ methods: { searchLowFaresRetrieve } });
      air.retrieveShop({});
      expect(searchLowFaresRetrieve.calledOnce).to.be.equal(true);
    });
  });

  describe('availability', () => {
    it('should check if correct function from service is called', () => {
      const availability = sinon.spy(() => {});
      const air = getAirServiceMock({ methods: { availability } });
      air.availability({});
      expect(availability.calledOnce).to.be.equal(true);
    });
  });

  describe('addSegments', () => {
    it('should check if correct function from service is called', () => {
      const addSegments = sinon.spy(() => {});
      const air = getAirServiceMock({ methods: { addSegments } });
      air.addSegments({
        version: 1,
        universalRecordLocatorCode: 'CODE',
        reservationLocatorCode: 'CODE'
      });
      expect(addSegments.calledOnce).to.be.equal(true);
    });
    it('should check if correct function from service is called when no details provided', () => {
      const addSegments = sinon.spy(() => {});
      const getBooking = sinon.spy(() => {});
      const getUniversalRecordByPNR = sinon.spy(() => Promise.resolve([{ pnr: 'PNR000' }]));
      const air = getAirServiceMock({
        methods: {
          addSegments,
          getBooking,
          getUniversalRecordByPNR
        }
      });
      air.addSegments({ pnr: 'PNR000' });
      expect(getUniversalRecordByPNR.calledOnce).to.be.equal(true);
    });
  });

  describe('toQueue', () => {
    it('should check if correct function from service is called', () => {
      const gdsQueue = sinon.spy(() => {});
      const air = getAirServiceMock({ methods: { gdsQueue } });
      air.toQueue({});
      expect(gdsQueue.calledOnce).to.be.equal(true);
    });
  });

  describe('book', () => {
    it('should check if correct function from service is called', () => {
      const params = {
        passengers: [],
        rule: 'RULE',
      };

      const airPricePricingSolutionXML = sinon.spy(
        () => Promise.resolve({ foo: 123 })
      );
      const createReservation = sinon.spy((options) => {
        expect(options.ActionStatusType).to.be.equal('TAU');
        expect(options.foo).to.be.equal(123);
        expect(options.rule).to.be.equal(params.rule);
        expect(options.passengers).to.be.equal(params.passengers);
        return Promise.resolve();
      });
      const cancelUR = sinon.spy(() => {});

      const air = getAirServiceMock({
        methods: {
          airPricePricingSolutionXML, createReservation
        }
      });

      return air.book(params).then(() => {
        expect(airPricePricingSolutionXML.calledOnce).to.be.equal(true);
        expect(createReservation.calledOnce).to.be.equal(true);
        expect(cancelUR.calledOnce).to.be.equal(false);
      });
    });

    it('should check if book is called correctly with TAU option provided', () => {
      const params = {
        passengers: [],
        rule: 'RULE',
        tau: '2020-02-08 09:30',
      };

      const airPricePricingSolutionXML = sinon.spy(
        () => Promise.resolve({ foo: 123 })
      );
      const createReservation = sinon.spy((options) => {
        expect(options.foo).to.be.equal(123);
        expect(options.ActionStatusType).to.be.equal('TAU');
        expect(options.rule).to.be.equal(params.rule);
        expect(options.passengers).to.be.equal(params.passengers);
        expect(options.tau).to.be.equal(params.tau);
        return Promise.resolve();
      });
      const cancelUR = sinon.spy(() => {});

      const air = getAirServiceMock({ methods: { airPricePricingSolutionXML, createReservation } });

      return air.book(params).then(() => {
        expect(airPricePricingSolutionXML.calledOnce).to.be.equal(true);
        expect(createReservation.calledOnce).to.be.equal(true);
        expect(cancelUR.calledOnce).to.be.equal(false);
      });
    });

    it('should call cancel ur if no valid fare', () => {
      const params = { passengers: [], rule: 'RULE', allowWaitlist: true };
      const airPricePricingSolutionXML = sinon.spy(
        () => Promise.resolve({ foo: 123 })
      );
      const createReservation = sinon.spy(
        () => Promise.reject(new AirRuntimeError.NoValidFare({
          'universal:UniversalRecord': { LocatorCode: 123 },
        }))
      );
      const cancelUR = sinon.spy((options) => {
        expect(options.LocatorCode).to.be.equal(123);
        return Promise.resolve();
      });

      const air = getAirServiceMock({
        methods: {
          airPricePricingSolutionXML,
          createReservation,
          cancelUR
        }
      });

      return air.book(params)
        .then(() => {
          throw new Error('Cant be success.');
        })
        .catch((err) => {
          expect(err).to.be.instanceof(AirRuntimeError.NoValidFare);
          expect(airPricePricingSolutionXML.calledOnce).to.be.equal(true);
          expect(createReservation.calledOnce).to.be.equal(true);
          expect(cancelUR.calledOnce).to.be.equal(true);
        });
    });

    it('should call cancel ur if segment booking failed', () => {
      const params = { passengers: [], rule: 'RULE', allowWaitlist: true };
      const airPricePricingSolutionXML = sinon.spy(
        () => Promise.resolve({ foo: 123 })
      );
      const createReservation = sinon.spy(
        () => Promise.reject(new AirRuntimeError.SegmentBookingFailed({
          'universal:UniversalRecord': { LocatorCode: 123 },
        }))
      );
      const cancelUR = sinon.spy((options) => {
        expect(options.LocatorCode).to.be.equal(123);
        return Promise.resolve();
      });

      const air = getAirServiceMock({
        methods: {
          cancelUR,
          airPricePricingSolutionXML,
          createReservation,
        }
      });

      return air.book(params)
        .then(() => {
          throw new Error('Cant be success.');
        })
        .catch((err) => {
          expect(err).to.be.instanceof(AirRuntimeError.SegmentBookingFailed);
          expect(airPricePricingSolutionXML.calledOnce).to.be.equal(true);
          expect(createReservation.calledOnce).to.be.equal(true);
          expect(cancelUR.calledOnce).to.be.equal(true);
        });
    });

    it('should not call cancel ur if other error', () => {
      const params = { passengers: [], rule: 'RULE', allowWaitlist: true };
      const airPricePricingSolutionXML = sinon.spy(
        () => Promise.resolve({ foo: 123 })
      );
      const createReservation = sinon.spy(
        () => Promise.reject(new AirRuntimeError.TicketingFailed({
          'universal:UniversalRecord': { LocatorCode: 123 },
        }))
      );
      const cancelUR = sinon.spy((options) => {
        expect(options.LocatorCode).to.be.equal(123);
        return Promise.resolve();
      });

      const air = getAirServiceMock({
        methods: {
          createReservation,
          airPricePricingSolutionXML,
          cancelUR
        }
      });

      return air.book(params)
        .then(() => {
          throw new Error('Cant be success.');
        })
        .catch((err) => {
          expect(err).to.be.instanceof(AirRuntimeError.TicketingFailed);
          expect(airPricePricingSolutionXML.calledOnce).to.be.equal(true);
          expect(createReservation.calledOnce).to.be.equal(true);
          expect(cancelUR.calledOnce).to.be.equal(false);
        });
    });

    it('should not call cancel ur if segment booking failed with SegmentBookingFailed or NoValidFare but restrictWaitlist=true', () => {
      const params = { passengers: [], rule: 'RULE', allowWaitlist: false };
      const airPricePricingSolutionXML = sinon.spy(
        () => Promise.resolve({ foo: 123 })
      );
      const createReservation = sinon.spy(
        () => Promise.reject(new AirRuntimeError.SegmentBookingFailed({
          detail: { },
        }))
      );
      const cancelUR = sinon.spy((options) => {
        expect(options.LocatorCode).to.be.equal(123);
        return Promise.resolve();
      });

      const air = getAirServiceMock({
        methods: {
          airPricePricingSolutionXML,
          createReservation,
          cancelUR
        }
      });

      return air.book(params)
        .then(() => {
          throw new Error('Cant be success.');
        })
        .catch((err) => {
          expect(err).to.be.instanceof(AirRuntimeError.SegmentBookingFailed);
          expect(airPricePricingSolutionXML.calledOnce).to.be.equal(true);
          expect(createReservation.calledOnce).to.be.equal(true);
          expect(cancelUR).to.have.callCount(0);
        });
    });

    it('should not call cancel ur if segment booking failed with NoValidFare but restrictWaitlist=true', () => {
      const params = { passengers: [], rule: 'RULE', allowWaitlist: false };
      const airPricePricingSolutionXML = sinon.spy(
        () => Promise.resolve({ foo: 123 })
      );
      const createReservation = sinon.spy(() => Promise.reject(new AirRuntimeError.NoValidFare({
        detail: { },
      })));
      const cancelUR = sinon.spy((options) => {
        expect(options.LocatorCode).to.be.equal(123);
        return Promise.resolve();
      });

      const air = getAirServiceMock({
        methods: { airPricePricingSolutionXML, createReservation, cancelUR }
      });

      return air.book(params)
        .then(() => {
          throw new Error('Cant be success.');
        })
        .catch((err) => {
          expect(err).to.be.instanceof(AirRuntimeError.NoValidFare);
          expect(airPricePricingSolutionXML.calledOnce).to.be.equal(true);
          expect(createReservation.calledOnce).to.be.equal(true);
          expect(cancelUR).to.have.callCount(0);
        });
    });

    it('should not call cancel ur if segment booking failed with other error and restrictWaitlist=true', () => {
      const params = { passengers: [], rule: 'RULE', allowWaitlist: false };
      const airPricePricingSolutionXML = sinon.spy(
        () => Promise.resolve({ foo: 123 })
      );
      const createReservation = sinon.spy(
        () => Promise.reject(new AirRuntimeError.SegmentWaitlisted({
          detail: { },
        }))
      );
      const cancelUR = sinon.spy((options) => {
        expect(options.LocatorCode).to.be.equal(123);
        return Promise.resolve();
      });

      const air = getAirServiceMock({
        methods: { createReservation, airPricePricingSolutionXML, cancelUR }
      });

      return air.book(params)
        .then(() => {
          throw new Error('Cant be success.');
        })
        .catch((err) => {
          expect(err).to.be.instanceof(AirRuntimeError.SegmentWaitlisted);
          expect(airPricePricingSolutionXML.calledOnce).to.be.equal(true);
          expect(createReservation.calledOnce).to.be.equal(true);
          expect(cancelUR).to.have.callCount(0);
        });
    });
  });

  describe('retrieve UR', () => {
    it('should check if correct function from service is called', () => {
      const getUniversalRecord = sinon.spy(() => {});
      const air = getAirServiceMock({ methods: { getUniversalRecord } });
      air.getUniversalRecord({});
      expect(getUniversalRecord.calledOnce).to.be.equal(true);
    });
  });

  describe('importBooking', () => {
    const params = {
      pnr: 'PNR001',
    };
    const segment = {
      date: moment().add(42, 'days').format('DDMMM'),
      airline: 'OK',
      from: 'DOH',
      to: 'ODM',
      comment: 'NO1',
      class: 'Y',
    };
    const pnrString = `${params.pnr}/`;
    const nonIataPnrString = `** THIS BF IS CURRENTLY IN USE **
 E7R- BUBO TRAVEL AGENCY       BRQ
${params.pnr}/HN BRQOU  E7RHN  AG 99999992 04JAN
  1.1SKORNOVA/MIROSLAVAMRS
** VENDOR LOCATOR DATA EXISTS **       >*VL;
** VENDOR REMARKS DATA EXISTS **       >*VR;
** SERVICE INFORMATION EXISTS **       >*SI;
** TINS REMARKS EXIST **               >*HTI;
** ELECTRONIC DATA EXISTS **           >*HTE;
** DIVIDED BOOKINGS EXIST **           >*DV;
FONE-BTST*BUBO TRAVEL AGENCY 00421 2 52635254
NOTE-
  1. VIEWTRIPNET TH 31DEC 0804Z
  2. -S*SPLIT PTY/04JAN/HNAG/BRQ/0T780B HN 04JAN 1114Z
><`;
    const segmentResult = (
      `1. ${segment.airline} OPEN ${segment.class}  ${segment.date} ${segment.from}${segment.to} ${segment.comment}`
    ).toUpperCase();
    const stubAsyncCall = (results) => {
      const call = sinon.stub();
      results.forEach((result, i) => {
        if (result instanceof Error) {
          call.onCall(i).rejects(result);
        } else {
          call.onCall(i).resolves(result);
        }
      });

      return call;
    };

    const getEmulatedTerminal = (results) => {
      const executeCommand = stubAsyncCall(results);
      const closeSession = sinon.spy(() => Promise.resolve(true));
      return {
        terminal: () => ({
          executeCommand,
          closeSession,
        }),
        executeCommand,
        closeSession,
      };
    };

    const checkError = (err, settings) => {
      if (settings.instanceOf) {
        expect(err).to.be.an.instanceOf(settings.instanceOf);
      }
      if (settings.causedBy) {
        expect(err.causedBy).to.be.an.instanceOf(settings.causedBy);
      }
      if (settings.callCounts) {
        settings.callCounts.forEach(
          ({ func, count }) => {
            expect(func).to.have.callCount(count);
          }
        );
      }
    };

    const assertServiceError = ({
      airFunctions,
      terminalResults,
      terminalCallCounts,
      instanceOf,
      causedBy,
    }) => {
      const airService = () => airFunctions.reduce(
        (acc, { name, func }) => ({
          ...acc,
          [name]: func,
        }),
        {}
      );
      const {
        terminal: terminalService,
        executeCommand,
        closeSession,
      } = getEmulatedTerminal(terminalResults);
      const createAirService = proxyquire('../../src/Services/Air/Air', {
        './AirService': airService,
        '../Terminal/Terminal': terminalService,
      });

      return createAirService({ auth })
        .getUniversalRecordByPNR(params)
        .catch((error) => {
          checkError(error, {
            instanceOf,
            causedBy,
            callCounts: [
              ...airFunctions,
              { func: executeCommand, count: terminalCallCounts.executeCommand },
              { func: closeSession, count: terminalCallCounts.closeSession },
            ]
          });
        });
    };

    const testOkProcess = (pnrResponse) => {
      const getUniversalRecordByPNR = stubAsyncCall([
        new AirRuntimeError.NoReservationToImport(),
        getURByPNRSampleBooked,
        getURByPNRSampleBooked,
      ]);
      const cancelBooking = sinon.spy(() => Promise.resolve(true));

      return assertServiceError({
        airFunctions: [
          { func: getUniversalRecordByPNR, name: 'getUniversalRecordByPNR', count: 1 },
          { func: cancelBooking, name: 'cancelBooking', count: 1 },
        ],
        terminalResults: [
          pnrResponse, segmentResult, true, true,
          [pnrString, segmentResult].join('\n'),
        ],
        terminalCallCounts: {
          executeCommand: 5,
          closeSession: 1,
        },
        instanceOf: AirRuntimeError.UnableToImportPnr,
        causedBy: AirRuntimeError.UnableToSaveBookingWithExtraSegment,
      });
    };

    it('should check if correct function from service is called', () => {
      const getUniversalRecordByPNR = sinon.spy(() => Promise.resolve({}));
      const airService = () => ({ getUniversalRecordByPNR });
      const createAirService = proxyquire('../../src/Services/Air/Air', {
        './AirService': airService,
      });
      return createAirService({ auth })
        .getUniversalRecordByPNR(params)
        .then(() => {
          expect(getUniversalRecordByPNR).to.have.callCount(1);
        });
    });
    it('should throw an error when something is wrong in parser', () => {
      const error = new Error('Some error');
      const getUniversalRecordByPNR = sinon.spy(() => Promise.reject(error));

      const airService = () => ({ getUniversalRecordByPNR });
      const createAirService = proxyquire('../../src/Services/Air/Air', {
        './AirService': airService,
      });
      return createAirService({ auth })
        .getUniversalRecordByPNR(params)
        .catch((importError) => {
          expect(importError).to.equal(error);
        });
    });
    it('should throw an error when it is unable to open PNR in rerminal', () => {
      const getUniversalRecordByPNR = sinon.spy(
        () => Promise.reject(new AirRuntimeError.NoReservationToImport())
      );

      return assertServiceError({
        airFunctions: [
          { func: getUniversalRecordByPNR, name: 'getUniversalRecordByPNR', count: 1 },
        ],
        terminalResults: ['FINISH OR IGNORE'],
        terminalCallCounts: {
          executeCommand: 1,
          closeSession: 1,
        },
        instanceOf: AirRuntimeError.UnableToImportPnr,
        causedBy: AirRuntimeError.UnableToOpenPNRInTerminal,
      });
    });

    it('should throw an error when it is unable to add an extra segment', () => {
      const getUniversalRecordByPNR = sinon.spy(
        () => Promise.reject(new AirRuntimeError.NoReservationToImport())
      );

      return assertServiceError({
        airFunctions: [
          { func: getUniversalRecordByPNR, name: 'getUniversalRecordByPNR', count: 1 },
        ],
        terminalResults: [
          pnrString, 'ERR: FORMAT',
        ],
        terminalCallCounts: {
          executeCommand: 2,
          closeSession: 1,
        },
        instanceOf: AirRuntimeError.UnableToImportPnr,
        causedBy: AirRuntimeError.UnableToAddExtraSegment,
      });
    });
    it('should throw an error when it is unable to add an extra segment (no segment added)', () => {
      const getUniversalRecordByPNR = sinon.spy(
        () => Promise.reject(new AirRuntimeError.NoReservationToImport())
      );

      return assertServiceError({
        airFunctions: [
          { func: getUniversalRecordByPNR, name: 'getUniversalRecordByPNR', count: 1 },
        ],
        terminalResults: [
          pnrString, segmentResult, true, true,
          [pnrString].join('\n'),
        ],
        terminalCallCounts: {
          executeCommand: 5,
          closeSession: 1,
        },
        instanceOf: AirRuntimeError.UnableToImportPnr,
        causedBy: AirRuntimeError.UnableToSaveBookingWithExtraSegment,
      });
    });
    it('should throw an error when it is unable to add an extra segment (no PNR parsed)', () => {
      const getUniversalRecordByPNR = sinon.spy(
        () => Promise.reject(new AirRuntimeError.NoReservationToImport())
      );

      return assertServiceError({
        airFunctions: [
          { func: getUniversalRecordByPNR, name: 'getUniversalRecordByPNR', count: 1 },
        ],
        terminalResults: [
          pnrString, segmentResult, true, true,
          [segmentResult].join('\n'),
        ],
        terminalCallCounts: {
          executeCommand: 5,
          closeSession: 1,
        },
        instanceOf: AirRuntimeError.UnableToImportPnr,
        causedBy: AirRuntimeError.UnableToSaveBookingWithExtraSegment,
      });
    });

    it('should run to the end if everything is OK', () => {
      testOkProcess(pnrString);
      testOkProcess(nonIataPnrString);
    });
  });

  describe('ticket', () => {
    it('should automatically get currency for commission', () => {
      const params = { pnr: 'PNR001' };

      const getUniversalRecordByPNR = sinon.spy(
        () => Promise.resolve(getURbyPNRSampleWithCurrency)
      );
      const foid = sinon.spy(() => {});
      const ticket = sinon.spy((options) => {
        expect(options.currency).to.be.equal('UAH');
        expect(options.ReservationLocator).to.be.equal('ABCDEF');
        return Promise.resolve();
      });

      const air = getAirServiceMock({
        methods: {
          getUniversalRecordByPNR,
          ticket,
          foid,
        }
      });

      return air.ticket(params).then(() => {
        expect(getUniversalRecordByPNR.calledOnce).to.be.equal(true);
        expect(ticket.calledOnce).to.be.equal(true);
        expect(foid.calledOnce).to.be.equal(false);
      });
    });

    it('should throw an error when currency is not found in totalPrice', () => {
      const params = { pnr: 'PNR001' };

      const getUniversalRecordByPNR = sinon.spy(
        () => Promise.resolve(getURbyPNRSampleTicketed.map(booking => ({
          ...booking,
          fareQuotes: [{
            pricingInfos: [{
              totalPrice: '10',
            }]
          }]
        })))
      );
      const ticket = sinon.spy(() => Promise.reject(new Error('No Call')));
      const foid = sinon.spy(() => Promise.reject(new Error('No Call')));

      const air = getAirServiceMock({ methods: { getUniversalRecordByPNR, foid, ticket } });

      return air.ticket(params)
        .catch((err) => {
          expect(err).to.be.instanceOf(AirRuntimeError.CouldNotRetrieveCurrency);
          expect(getUniversalRecordByPNR.calledOnce).to.be.equal(true);
          expect(ticket.calledOnce).to.be.equal(false);
          expect(foid.calledOnce).to.be.equal(false);
        });
    });

    it('should throw an error when currency is not found', () => {
      const params = { pnr: 'PNR001' };

      const getUniversalRecordByPNR = sinon.spy(
        () => Promise.resolve(getURbyPNRSampleTicketed)
      );
      const ticket = sinon.spy(() => Promise.reject(new Error('Should not be called')));
      const foid = sinon.spy(() => Promise.reject(new Error('Should not be called')));

      const air = getAirServiceMock({
        methods: {
          foid,
          getUniversalRecordByPNR,
          ticket,
        }
      });

      return air.ticket(params).catch((err) => {
        expect(err).to.be.instanceOf(AirRuntimeError.CouldNotRetrieveCurrency);
        expect(getUniversalRecordByPNR.calledOnce).to.be.equal(true);
        expect(ticket.calledOnce).to.be.equal(false);
        expect(foid.calledOnce).to.be.equal(false);
      });
    });

    it('should check if correct function from service is called', () => {
      const params = { pnr: 'PNR001' };

      const getUniversalRecordByPNR = sinon.spy(
        () => Promise.resolve(getURbyPNRSampleWithCurrency)
      );
      const ticket = sinon.spy((options) => {
        expect(options.ReservationLocator).to.be.equal('ABCDEF');
        return Promise.resolve();
      });
      const foid = sinon.spy(() => {});

      const air = getAirServiceMock({
        methods: { foid, ticket, getUniversalRecordByPNR }
      });

      return air.ticket(params).then(() => {
        expect(ticket.calledOnce).to.be.equal(true);
        expect(foid.calledOnce).to.be.equal(false);
        expect(getUniversalRecordByPNR.calledOnce).to.be.equal(true);
      });
    });

    it('should resolve foid and reticket', () => {
      const params = { pnr: 'PNR001' };

      const getUniversalRecordByPNR = sinon.spy(
        () => Promise.resolve(getURbyPNRSampleWithCurrency)
      );
      const ticketResponses = [
        Promise.resolve(),
        Promise.reject(new AirRuntimeError.TicketingFoidRequired([1])),
      ];

      const ticket = sinon.spy((options) => {
        expect(options.ReservationLocator).to.be.equal('ABCDEF');
        return ticketResponses.pop();
      });

      const foid = sinon.spy(() => Promise.resolve({}));
      const log = sinon.spy(() => {});
      const service = () => ({ getUniversalRecordByPNR, ticket, foid });

      const createAirService = proxyquire('../../src/Services/Air/Air', {
        './AirService': service,
      });

      return createAirService({
        auth,
        debug: true,
        options: {
          logFunction: log,
        }
      }).ticket(params).then(() => {
        expect(getUniversalRecordByPNR.calledTwice).to.be.equal(true);
        expect(ticket.calledTwice).to.be.equal(true);
        expect(log.calledOnce).to.be.equal(true);
        expect(foid.calledOnce).to.be.equal(true);
      });
    });

    it('should retry ticketing if PNR busy', function () {
      this.timeout(3000);
      const params = { pnr: 'PNR001' };

      const getUniversalRecordByPNR = sinon.spy(
        () => Promise.resolve(getURbyPNRSampleWithCurrency)
      );
      const ticketResponses = [
        Promise.resolve(),
        Promise.reject(new AirRuntimeError.TicketingPNRBusy([1])),
      ];

      const ticket = sinon.spy((options) => {
        expect(options.ReservationLocator).to.be.equal('ABCDEF');
        return ticketResponses.pop();
      });


      const air = getAirServiceMock({ methods: { getUniversalRecordByPNR, ticket } });

      return air.ticket(params).then(() => {
        expect(getUniversalRecordByPNR.calledOnce).to.be.equal(true);
        expect(ticket.calledTwice).to.be.equal(true);
      });
    });


    it('should set FOID and retry ticketing if PNR busy', function () {
      this.timeout(5000);
      const params = { pnr: 'PNR001' };

      const getUniversalRecordByPNR = sinon.spy(
        () => Promise.resolve(getURbyPNRSampleWithCurrency)
      );
      const ticketResponses = [
        () => Promise.resolve(),
        () => Promise.reject(new AirRuntimeError.TicketingPNRBusy()),
        () => Promise.reject(new AirRuntimeError.TicketingFoidRequired()),
      ];

      const ticket = sinon.spy((options) => {
        expect(options.ReservationLocator).to.be.equal('ABCDEF');
        return ticketResponses.pop()();
      });

      const foid = sinon.spy(() => Promise.resolve({}));

      const air = getAirServiceMock({ methods: { getUniversalRecordByPNR, ticket, foid } });

      return air.ticket(params).then(() => {
        expect(getUniversalRecordByPNR.callCount).to.be.equal(2);
        expect(foid.calledOnce).to.be.equal(true);
        expect(ticket.callCount).to.be.equal(3);
      });
    });

    it('should resolve rethrow other errors', () => {
      const params = { pnr: 'PNR001' };

      const getUniversalRecordByPNR = sinon.spy(
        () => Promise.resolve(getURbyPNRSampleWithCurrency)
      );
      const ticketResponses = [
        Promise.reject(new AirRuntimeError.NoValidFare()),
      ];

      const ticket = sinon.spy((options) => {
        expect(options.ReservationLocator).to.be.equal('ABCDEF');
        return ticketResponses.pop();
      });

      const foid = sinon.spy(() => {});
      const service = () => ({ getUniversalRecordByPNR, ticket, foid });

      const createAirService = proxyquire('../../src/Services/Air/Air', {
        './AirService': service,
      });

      return createAirService({ auth }).ticket(params).then(() => {
        throw new Error('Cant be successfull');
      }).catch(() => {
        expect(getUniversalRecordByPNR.calledOnce).to.be.equal(true);
        expect(ticket.calledOnce).to.be.equal(true);
        expect(foid.calledOnce).to.be.equal(false);
      });
    });
  });

  describe('flightInfo', () => {
    it('should check if correct function from service is called', () => {
      const flightInfo = sinon.spy((options) => {
        expect(options.flightInfoCriteria).to.be.an('array');
      });

      const air = getAirServiceMock({ methods: { flightInfo } });
      air.flightInfo({});
      expect(flightInfo.calledOnce).to.be.equal(true);
    });

    it('should check if correct function from service is called with array params', () => {
      const flightInfo = sinon.spy((options) => {
        expect(options.flightInfoCriteria).to.be.an('array');
      });

      const air = getAirServiceMock({
        methods: {
          flightInfo
        }
      });
      air.flightInfo([{}]);
      expect(flightInfo.calledOnce).to.be.equal(true);
    });
  });

  describe('getTicket', () => {
    it('should fail if service fails with error', async () => {
      const getTicket = sinon.stub().rejects(new RequestSoapError.SoapUnexpectedError());
      const AirService = () => ({ getTicket });
      const createAirService = proxyquire('../../src/Services/Air/Air', {
        './AirService': AirService,
      });
      const air = createAirService({ auth });
      try {
        await air.getTicket({ ticketNumber: '0649902789376' });
        throw new Error('Error was not thrown');
      } catch (err) {
        expect(err).to.be.an.instanceof(RequestSoapError);
        expect(getTicket).to.be.calledOnceWith({ ticketNumber: '0649902789376', allowNoProviderLocatorCodeRetrieval: false });
      }
    });
    it('should fail when no itinerary present to import', () => {
      const AirService = () => ({
        getUniversalRecordByPNR: () => Promise.reject(new AirRuntimeError()),
        getTicket: () => Promise.reject(new AirRuntimeError.TicketInfoIncomplete()),
        importBooking: () => Promise.reject(new AirRuntimeError()),
      });
      const createTerminalService = () => ({
        executeCommand: () => Promise.resolve('RLOC 1G PNR001'),
        closeSession: () => Promise.resolve(true),
      });
      const createAirService = proxyquire('../../src/Services/Air/Air', {
        './AirService': AirService,
        '../Terminal/Terminal': createTerminalService,
      });
      const service = createAirService({ auth });
      service.getTicket({ ticketNumber: '0649902789376' })
        .then(() => Promise.reject(new Error('Error has not occured')))
        .catch((err) => {
          expect(err).to.be.an.instanceof(AirRuntimeError);
        });
    });

    it('should get ticket data if duplicate ticket found', () => {
      const originalURbyPNR = [
        {
          pnr: 'PNR101',
          uapi_ur_locator: 'UAPI101',
          uapi_reservation_locator: 'ABCDEF101',
        },
      ];

      const getUniversalRecordByPNR = sinon.stub();
      getUniversalRecordByPNR.onCall(0).resolves(originalURbyPNR);

      const getTicket = sinon.stub();
      const getTickets = sinon.stub();

      getTicket.onCall(0).rejects(new AirRuntimeError.DuplicateTicketFound());
      getTickets.onCall(0).resolves([{ ticketNumber: '0649902789376' }]);
      const getPNRByTicketNumber = sinon.spy(() => Promise.resolve('PNR101'));

      const air = getAirServiceMock({
        methods: {
          getTicket,
          getTickets,
          getUniversalRecordByPNR
        }
      });

      const AirService = air;
      AirService.getPNRByTicketNumber = getPNRByTicketNumber.bind(AirService);

      return AirService.getTicket({ ticketNumber: '0649902789376' })
        .then((res) => {
          expect(res).to.be.an('object').and.to.have.property('ticketNumber');
          expect(res.ticketNumber).to.equal('0649902789376');
          expect(getTicket.calledOnce).to.be.equal(true);
          expect(getTickets.calledOnce).to.be.equal(true);
          expect(getPNRByTicketNumber.calledOnce).to.be.equal(true);
          expect(getUniversalRecordByPNR.calledOnce).to.be.equal(true);
        });
    });


    it('should rethrow getTickets error in case of duplicate ticket found and no split booking data', () => {
      const originalURbyPNR = [
        {
          pnr: 'PNR101',
          uapi_ur_locator: 'UAPI101',
          uapi_reservation_locator: 'ABCDEF101',
        },
      ];

      const getUniversalRecordByPNR = sinon.stub().resolves(originalURbyPNR);

      const getTicket = sinon.stub();
      const getTickets = sinon.stub();

      getTicket.onCall(0).rejects(new AirRuntimeError.DuplicateTicketFound());
      getTickets.onCall(0).rejects(new Error('some getTickets error'));
      const getPNRByTicketNumber = sinon.spy(() => Promise.resolve('PNR101'));

      const air = getAirServiceMock({
        methods: {
          getTicket,
          getTickets,
          getUniversalRecordByPNR
        }
      });

      const AirService = air;
      AirService.getPNRByTicketNumber = getPNRByTicketNumber.bind(AirService);

      return AirService.getTicket({ ticketNumber: '0649902789376' })
        .then(() => Promise.reject(new Error('Error has not occured')))
        .catch((err) => {
          expect(err).to.be.an.instanceof(AirRuntimeError.UnableToRetrieveTickets);
        });
    });

    it('should get ticket data with additional queries in case of TicketInfoIncomplete', async () => {
      const completeInfo = {
        pnr: 'PNR001',
        ticketNumber: '0649902789376',
        taxesInfo: []
      };

      const getTicket = sinon.stub();

      getTicket.onCall(0).throws(new AirRuntimeError.TicketInfoIncomplete());
      getTicket.onCall(1).resolves(completeInfo);

      const getPNRByTicketNumber = sinon.stub().resolves('PNR001');
      const getTickets = sinon.stub().resolves([{
        pnr: 'PNR001',
        ticketNumber: '0649902789375',
      }]);
      const getUniversalRecordByPNR = sinon.stub().resolves(getURbyPNRSampleTicketed);

      const air = getAirServiceMock({
        methods: {
          getTicket,
          getTickets,
          getUniversalRecordByPNR,
        }
      });
      air.getPNRByTicketNumber = getPNRByTicketNumber.bind(air);

      try {
        await air.getTicket({ ticketNumber: '0649902789376' });
      } catch (err) {
        expect(err).to.be.an.instanceof(AirRuntimeError.TicketInfoIncomplete);
      }
    });
  });

  describe('getPNRByTicketNumber', () => {
    it('should fail when ticket data not available by ticket number', async () => {
      const response = fs.readFileSync(
        path.join(terminalResponsesDir, 'getTicketNotExists.txt')
      ).toString();
      const createTerminalService = () => ({
        // The only command is executed, no analyze needed
        executeCommand: () => Promise.resolve(response),
        closeSession: () => Promise.resolve(true),
      });
      const createAirService = proxyquire('../../src/Services/Air/Air', {
        '../Terminal/Terminal': createTerminalService,
      });
      const service = createAirService({ auth });

      try {
        await service.getPNRByTicketNumber({ ticketNumber: '0649902789000' });
        expect('should be rejected').to.be.eq('but not rejected');
      } catch (err) {
        expect(err).to.be.instanceof(AirRuntimeError.ParseTicketPNRError);
      }
    });
    it('should fail when something fails in executeCommand', async () => {
      const createTerminalService = () => ({
        // The only command is executed, no analyze needed
        executeCommand: () => Promise.reject(new Error('Some error')),
        closeSession: () => Promise.resolve(true),
      });
      const createAirService = proxyquire('../../src/Services/Air/Air', {
        '../Terminal/Terminal': createTerminalService,
      });
      const service = createAirService({ auth });

      try {
        await service.getPNRByTicketNumber({ ticketNumber: '0649902789000' });
        expect('should be rejected').to.be.eq('but not rejected');
      } catch (err) {
        expect(err).to.be.instanceof(Error);
      }
    });
    it('should fail when something fails in closeSession', (done) => {
      const createTerminalService = () => ({
        // The only command is executed, no analyze needed
        executeCommand: () => Promise.resolve(true),
        closeSession: () => Promise.reject(new Error('Some error')),
      });
      const createAirService = proxyquire('../../src/Services/Air/Air', {
        '../Terminal/Terminal': createTerminalService,
      });
      const service = createAirService({ auth });
      service.getPNRByTicketNumber({ ticketNumber: '0649902789000' })
        .then(() => done(new Error('Error has not occured')))
        .catch((err) => {
          expect(err).to.be.an.instanceof(Error);
          done();
        });
    });
    it('should return PNR when response is OK', async () => {
      const response = fs.readFileSync(
        path.join(terminalResponsesDir, 'getTicketVoid.txt')
      ).toString();
      const createTerminalService = () => ({
        // The only command is executed, no analyze needed
        executeCommand: () => Promise.resolve(response),
        closeSession: () => Promise.resolve(true),
      });
      const createAirService = proxyquire('../../src/Services/Air/Air', {
        '../Terminal/Terminal': createTerminalService,
      });
      const service = createAirService({ auth });

      const pnr = await service.getPNRByTicketNumber({ ticketNumber: '0649902789000' });
      expect(pnr).to.equal('8167L2');
    });
  });

  describe('getTickets', () => {
    it('should throw an error when some function fails', async () => {
      const errorCases = [
        {
          InstanceError: AirRuntimeError.UnableToRetrieveTickets,
          CausedByInstanceError: Error
        },
        {
          InstanceError: AirRuntimeError.NoAgreement,
          CausedByInstanceError: AirRuntimeError.NoAgreement
        }];

      await Promise.all(errorCases.map(async ({ InstanceError, CausedByInstanceError }) => {
        const AirService = () => ({
          getUniversalRecordByPNR: () => Promise.resolve({ uapi_reservation_locator: 'RLC001' }),
          getTickets: () => Promise.reject(new CausedByInstanceError('Some error')),
        });
        const createAirService = proxyquire('../../src/Services/Air/Air', {
          './AirService': AirService,
        });
        const service = createAirService({ auth });

        try {
          await service.getTickets({ uapi_reservation_locator: 'RLC001' });
          throw new Error('No error thrown!');
        } catch (err) {
          console.log(err);
          expect(err).to.be.an.instanceof(InstanceError);

          if (err.causedBy) {
            expect(err.causedBy).to.be.an.instanceof(CausedByInstanceError);
          }
        }
      }));
    });
    it('should work with right responses', (done) => {
      const importBookingVoidResponse = JSON.parse(
        fs.readFileSync(path.join(responsesDir, 'importBooking_VOID.json')).toString()
      );
      const getTicketVoidResponse = JSON.parse(
        fs.readFileSync(path.join(responsesDir, 'getTicket_VOID.json')).toString()
      );
      const AirService = () => ({
        getUniversalRecordByPNR: () => Promise.resolve(importBookingVoidResponse),
        getTickets: () => Promise.resolve(getTicketVoidResponse),
      });
      const createAirService = proxyquire('../../src/Services/Air/Air', {
        './AirService': AirService,
      });
      const service = createAirService({ auth });
      service.getTickets({ pnr: 'XDQTZ4' })
        .then((response) => {
          expect(response).to.be.an('array');
        })
        .then(done)
        .catch(err => done(err.causedBy));
    });
  });

  describe('searchBookingsByPassengerName', () => {
    it('should check if list correctly parsed', () => {
      const returnList = sinon.spy(() => Promise.resolve('listscreen'));
      const returnBooking = sinon.spy(() => Promise.resolve('pnrscreen'));

      const executeCommand = sinon.spy((command) => {
        expect(command).to.be.a('string');
        expect(command.match(/\*-?.*/)).to.be.not.equal(null);
        if (command[1] === '-') {
          return returnList();
        }
        return returnBooking();
      });

      const closeSession = sinon.spy(() => Promise.resolve());

      const bookingPnr = sinon.spy(
        screen => ((screen === 'pnrscreen') ? '123QWE' : null)
      );

      const searchPassengersList = sinon.spy(
        screen => (
          (screen === 'listscreen')
            ? [{ id: 1, name: 'first' }, { id: 2, name: 'last' }]
            : null
        )
      );


      const createAirService = proxyquire('../../src/Services/Air/Air', {
        '../../utils': {
          parsers: {
            bookingPnr,
            searchPassengersList,
          },
        },
        '../Terminal/Terminal': () => ({
          executeCommand,
          closeSession,
        }),
      });

      return createAirService({ auth })
        .searchBookingsByPassengerName({ searchPhrase: 'OK' })
        .then((res) => {
          expect(res.type).to.be.equal('list');
          expect(res.data.length).to.be.equal(2);
          expect(res.data[0].pnr).to.be.equal('123QWE');
          expect(res.data[0].name).to.be.equal('first');
          expect(returnList.callCount).to.be.equal(3);
          expect(bookingPnr.callCount).to.be.equal(2);
          expect(searchPassengersList.callCount).to.be.equal(1);
          expect(returnBooking.calledTwice).to.be.equal(true);
          expect(executeCommand.callCount).to.be.equal(5);
          expect(closeSession.callCount).to.be.equal(3);
        });
    });

    it('should check if pnr parsed when list is null', () => {
      const returnBooking = sinon.spy(() => Promise.resolve('pnrscreen'));
      const executeCommand = sinon.spy(() => returnBooking());

      const bookingPnr = sinon.spy(
        screen => ((screen === 'pnrscreen') ? '123QWE' : null)
      );

      const searchPassengersList = sinon.spy(
        screen => (
          (screen === 'listscreen')
            ? [{ id: 1, name: 'first' }, { id: 2, name: 'last' }]
            : null
        )
      );


      const createAirService = proxyquire('../../src/Services/Air/Air', {
        '../../utils': {
          parsers: {
            bookingPnr,
            searchPassengersList,
          },
        },
        '../Terminal/Terminal': () => ({
          executeCommand,
          closeSession: () => Promise.resolve(),
        }),
      });

      return createAirService({ auth })
        .searchBookingsByPassengerName({ searchPhrase: 'OK' })
        .then((res) => {
          expect(res.type).to.be.equal('pnr');
          expect(res.data).to.be.equal('123QWE');
          expect(bookingPnr.callCount).to.be.equal(1);
          expect(searchPassengersList.callCount).to.be.equal(1);
          expect(returnBooking.calledOnce).to.be.equal(true);
          expect(executeCommand.calledOnce).to.be.equal(true);
        });
    });

    it('should check if pnr parsed when list is null', () => {
      const returnList = sinon.spy(() => Promise.resolve({}));
      const executeCommand = sinon.spy(() => returnList());

      const parseAny = () => [{ id: 1, name: 'first' }, { id: 2, name: 'last' }];

      const createAirService = proxyquire('../../src/Services/Air/Air', {
        '../../utils': {
          parsers: {
            bookingPnr: parseAny,
            searchPassengersList: parseAny,
          },
        },
        '../Terminal/Terminal': () => ({
          executeCommand,
          closeSession: () => Promise.resolve(),
        }),
      });

      return createAirService({ auth })
        .searchBookingsByPassengerName({ searchPhrase: 'OK' })
        .then(() => Promise.reject(new Error('Cant be answer.')))
        .catch((err) => {
          expect(err).to.be.an.instanceof(AirRuntimeError.RequestInconsistency);
        });
    });
  });

  describe('cancelTicket', () => {
    it('should throw a general error', () => {
      const air = getAirServiceMock({
        methods: { getTicket: () => Promise.reject(new Error('Some error')) }
      });

      return air
        .cancelTicket()
        .then(() => Promise.reject(new Error('Error has not occured')))
        .catch((err) => {
          expect(err).to.be.an.instanceof(AirRuntimeError.FailedToCancelTicket);
          expect(err.causedBy).to.be.an.instanceof(Error);
        });
    });
    it('should cancel ticket if info is complete', () => {
      // Spies
      const getTicket = sinon.spy(() => Promise.resolve({
        pnr: 'PNR001',
        ticketNumber: '1234567890123',
      }));
      const cancelTicket = sinon.spy(() => Promise.resolve(true));
      // Services
      const airService = () => ({
        getTicket,
        cancelTicket,
      });
      const createAirService = proxyquire('../../src/Services/Air/Air', {
        './AirService': airService,
      });

      const service = createAirService({ auth });

      return service.cancelTicket({
        ticketNumber: '1234567890123',
      })
        .then(() => {
          expect(getTicket).to.have.callCount(1);
          expect(cancelTicket).to.have.callCount(1);
        });
    });
    it('should get ticket data if incomplete and be OK', async () => {
      // Get ticket stub to return 2 different values on different calls
      const getTicket = sinon.stub().rejects(new AirRuntimeError.TicketInfoIncomplete());
      const getTickets = sinon.stub().resolves([{
        pnr: 'PNR001',
        ticketNumber: '1234567890123',
      }]);
      // Spies
      const cancelTicket = sinon.spy(() => Promise.resolve(true));
      const getUniversalRecordByPNR = sinon.spy(() => Promise.resolve(getURByPNRSampleBooked));
      const executeCommand = sinon.spy(() => Promise.resolve('RLOC 1G PNR001'));
      const closeSession = sinon.spy(() => Promise.resolve(true));
      // Services
      const airService = () => ({
        getTicket,
        getTickets,
        cancelTicket,
        getUniversalRecordByPNR,
      });
      const terminalService = () => ({
        executeCommand,
        closeSession,
      });
      const createAirService = proxyquire('../../src/Services/Air/Air', {
        './AirService': airService,
        '../Terminal/Terminal': terminalService,
      });

      const service = createAirService({ auth });
      await service.cancelTicket({ ticketNumber: '1234567890123' });

      expect(getTicket).to.have.callCount(1);
      expect(getTickets).to.have.callCount(1);
      expect(cancelTicket).to.have.callCount(1);
      expect(getUniversalRecordByPNR).to.have.callCount(1);
      expect(executeCommand).to.have.callCount(1);
      expect(closeSession).to.have.callCount(1);
    });
  });
  describe('cancelBooking', () => {
    it('should throw general error', () => {
      const airService = () => ({
        getUniversalRecordByPNR: () => Promise.resolve({ uapi_reservation_locator: 'RLC001' }),
        getTickets: () => Promise.reject(new Error('Some error')),
      });

      const createAirService = proxyquire('../../src/Services/Air/Air', {
        './AirService': airService,
      });

      return createAirService({ auth })
        .cancelBooking({
          pnr: 'PNR001',
        })
        .then(() => Promise.reject(new Error('Error has not occured')))
        .catch((err) => {
          expect(err).to.be.an.instanceof(AirRuntimeError.FailedToCancelPnr);
          expect(err.causedBy).to.be.an.instanceof(Error);
        });
    });
    it('should cancel PNR if no tickets available', () => {
      // Spies
      const getUniversalRecordByPNR = sinon.spy(
        () => Promise.resolve(getURbyPNRSampleTicketedWithEmptyTickets)
      );
      const cancelBooking = sinon.spy(() => Promise.resolve(true));
      const getTicket = sinon.spy(() => Promise.resolve({
        coupons: [],
      }));

      // Services
      const airService = () => ({
        getUniversalRecordByPNR,
        getTicket,
        cancelBooking,
        getTickets: () => Promise.resolve([]),
      });
      const createAirService = proxyquire('../../src/Services/Air/Air', {
        './AirService': airService,
      });

      return createAirService({ auth })
        .cancelBooking({
          pnr: 'PNR001',
        })
        .then(() => {
          expect(getUniversalRecordByPNR).to.have.callCount(3);
          expect(getTicket).to.have.callCount(0);
          expect(cancelBooking).to.have.callCount(1);
        });
    });
    it('should cancel PNR if tickets have only VOID coupons', () => {
      // Spies
      const getUniversalRecordByPNR = sinon.spy(() => Promise.resolve(getURbyPNRSampleTicketed));
      const cancelBooking = sinon.spy(() => Promise.resolve(true));
      const getTickets = sinon.spy(() => Promise.resolve([{
        tickets: [{
          coupons: [{
            status: 'V',
          }, {
            status: 'V',
          }],
        }],
      }]));

      // Services
      const airService = () => ({
        getUniversalRecordByPNR,
        getTickets,
        cancelBooking,
      });
      const createAirService = proxyquire('../../src/Services/Air/Air', {
        './AirService': airService,
      });

      return createAirService({ auth })
        .cancelBooking({
          pnr: 'PNR001',
        })
        .then(() => {
          expect(getUniversalRecordByPNR).to.have.callCount(3);
          expect(getTickets).to.have.callCount(1);
          expect(cancelBooking).to.have.callCount(1);
        });
    });
    it('should fail with AirRuntimeError.PNRHasOpenTickets PNR if tickets have OPEN coupons and no cancelTicket option', () => {
      const someTickets = [
        {
          tickets: [{
            coupons: [{
              status: 'V',
            }, {
              status: 'V',
            }],
          }],
        },
        {
          tickets: [{
            coupons: [{
              status: 'O',
            }, {
              status: 'O',
            }],
          }],
        },
      ];

      // Spies
      const getUniversalRecordByPNR = sinon.spy(() => Promise.resolve(getURbyPNRSampleTicketed));
      const cancelBooking = sinon.spy(() => Promise.resolve(true));
      const getTickets = sinon.spy(() => Promise.resolve(someTickets));

      // Services
      const airService = () => ({
        getUniversalRecordByPNR,
        getTickets,
        cancelBooking,
      });
      const createAirService = proxyquire('../../src/Services/Air/Air', {
        './AirService': airService,
      });

      return createAirService({ auth })
        .cancelBooking({
          pnr: 'PNR001',
        })
        .catch((err) => {
          expect(err).to.be.an.instanceof(AirRuntimeError.FailedToCancelPnr);
          expect(err.causedBy).to.be.an.instanceof(AirRuntimeError.PNRHasOpenTickets);
          expect(getUniversalRecordByPNR).to.have.callCount(2);
          expect(getTickets).to.have.callCount(1);
          expect(cancelBooking).to.have.callCount(0);
        });
    });
    it('should succeed when there are no VOID, but REFUNDED tickets', () => {
      // Spies
      const getUniversalRecordByPNR = sinon.spy(() => Promise.resolve(getURbyPNRSampleTicketed));
      const cancelTicket = sinon.spy(() => Promise.resolve(true));
      const cancelBooking = sinon.spy(() => Promise.resolve(true));

      const getTickets = sinon.spy(() => Promise.resolve([
        {
          tickets: [{
            coupons: [{
              status: 'R',
            }, {
              status: 'R',
            }],
          }],
        },
      ]));

      // Services
      const airService = () => ({
        getUniversalRecordByPNR,
        getTickets,
        cancelBooking,
        cancelTicket,
      });
      const createAirService = proxyquire('../../src/Services/Air/Air', {
        './AirService': airService,
      });

      return createAirService({ auth })
        .cancelBooking({
          pnr: 'PNR001',
        })
        .then(() => {
          expect(getUniversalRecordByPNR).to.have.callCount(3);
          expect(getTickets).to.have.callCount(1);
          expect(cancelBooking).to.have.callCount(1);
        });
    });
    it('should succeed when there are VOID and REFUNDED tickets', () => {
      // Spies
      const getUniversalRecordByPNR = sinon.spy(() => Promise.resolve(getURbyPNRSampleTicketed));
      const cancelTicket = sinon.spy(() => Promise.resolve(true));
      const cancelBooking = sinon.spy(() => Promise.resolve(true));

      const getTickets = sinon.spy(() => Promise.resolve([
        {
          tickets: [{
            coupons: [{
              status: 'R',
            }, {
              status: 'R',
            }],
          }],
        },
        {
          tickets: [{
            coupons: [{
              status: 'V',
            }, {
              status: 'V',
            }],
          }],
        },
      ]));

      // Services
      const airService = () => ({
        getUniversalRecordByPNR,
        getTickets,
        cancelBooking,
        cancelTicket,
      });
      const createAirService = proxyquire('../../src/Services/Air/Air', {
        './AirService': airService,
      });

      return createAirService({ auth })
        .cancelBooking({
          pnr: 'PNR001',
        })
        .then(() => {
          expect(getUniversalRecordByPNR).to.have.callCount(3);
          expect(getTickets).to.have.callCount(1);
          expect(cancelBooking).to.have.callCount(1);
        });
    });
    it('should succeed when there are OPEN and VOID tickets and cancelTickets = true', () => {
      // Spies
      const getUniversalRecordByPNR = sinon.spy(() => Promise.resolve(getURbyPNRSampleTicketed));
      const cancelTicket = sinon.spy(() => Promise.resolve(true));
      const cancelBooking = sinon.spy(() => Promise.resolve(true));

      const getTickets = sinon.spy(() => Promise.resolve([
        {
          tickets: [{
            coupons: [{
              status: 'V',
            }, {
              status: 'V',
            }],
          }],
        },
        {
          tickets: [{
            coupons: [{
              status: 'O',
            }, {
              status: 'O',
            }],
          }, {
            coupons: [{
              status: 'V',
            }, {
              status: 'V',
            }],
          }],
        },
      ]));

      // Services
      const airService = () => ({
        getUniversalRecordByPNR,
        getTickets,
        cancelBooking,
        cancelTicket,
      });
      const createAirService = proxyquire('../../src/Services/Air/Air', {
        './AirService': airService,
      });

      return createAirService({ auth })
        .cancelBooking({
          pnr: 'PNR001',
          cancelTickets: true,
        })
        .then(() => {
          expect(getUniversalRecordByPNR).to.have.callCount(3);
          expect(getTickets).to.have.callCount(1);
          expect(cancelBooking).to.have.callCount(1);
          expect(cancelTicket).to.have.callCount(1);
        });
    });
    it('should fail with AirRuntimeError.PNRHasOpenTickets PNR if tickets have coupons other than OPEN', () => {
      // Spies
      const getUniversalRecordByPNR = sinon.spy(() => Promise.resolve(getURbyPNRSampleTicketed));
      const cancelBooking = sinon.spy(() => Promise.resolve(true));
      const getTickets = sinon.spy(() => Promise.resolve([
        {
          tickets: [{
            coupons: [{
              status: 'V',
            }, {
              status: 'V',
            }],
          }],
        },
        {
          tickets: [{
            coupons: [{
              status: 'F',
            }, {
              status: 'A',
            }],
          }],
        },
      ]));

      // Services
      const airService = () => ({
        getUniversalRecordByPNR,
        getTickets,
        cancelBooking,
      });
      const createAirService = proxyquire('../../src/Services/Air/Air', {
        './AirService': airService,
      });

      return createAirService({ auth })
        .cancelBooking({
          pnr: 'PNR001',
          cancelTickets: true,
        })
        .catch((err) => {
          expect(err).to.be.an.instanceof(AirRuntimeError.FailedToCancelPnr);
          expect(err.causedBy).to.be.an.instanceof(
            AirRuntimeError.UnableToCancelTicketStatusNotOpen
          );
          expect(getUniversalRecordByPNR).to.have.callCount(2);
          expect(getTickets).to.have.callCount(1);
          expect(cancelBooking).to.have.callCount(0);
        });
    });
    it('should cancel tickets and PNR if no errors occured', () => {
      // Spies
      const getUniversalRecordByPNR = sinon.spy(() => Promise.resolve(getURbyPNRSampleTicketed));
      const cancelTicket = sinon.spy(() => Promise.resolve(true));
      const cancelBooking = sinon.spy(() => Promise.resolve(true));
      const getTickets = sinon.spy(() => Promise.resolve([
        {
          tickets: [{
            coupons: [{
              status: 'V',
            }, {
              status: 'V',
            }],
          }],
        },
        {
          tickets: [{
            coupons: [{
              status: 'O',
            }, {
              status: 'O',
            }],
          }],
        },
      ]));

      // Services
      const airService = () => ({
        getUniversalRecordByPNR,
        getTickets,
        cancelBooking,
        cancelTicket,
      });
      const createAirService = proxyquire('../../src/Services/Air/Air', {
        './AirService': airService,
      });

      return createAirService({ auth })
        .cancelBooking({
          pnr: 'PNR001',
          cancelTickets: true,
        })
        .then((result) => {
          expect(result).to.equal(true);
          expect(getUniversalRecordByPNR).to.have.callCount(3);
          expect(getTickets).to.have.callCount(1);
          expect(cancelTicket).to.have.callCount(1);
          expect(cancelBooking).to.have.callCount(1);
        });
    });
  });

  describe('getExchangeInformation', () => {
    it('should check functions to be called', () => {
      const d = moment();
      const getUniversalRecordByPNR = sinon.spy(
        () => Promise.resolve(getURByPNRSampleBooked)
      );

      const exchange = sinon.spy(({ bookingDate }) => {
        expect(bookingDate).to.be.equal(d.format('YYYY-MM-DD'));
      });

      const airService = () => ({
        exchangeQuote: exchange,
        getUniversalRecordByPNR,
      });

      const createAirService = proxyquire('../../src/Services/Air/Air', {
        './AirService': airService,
      });

      const service = createAirService({ auth });

      return service.getExchangeInformation({
        pnr: 'PNR001',
      }).then(() => {
        expect(getUniversalRecordByPNR).to.have.callCount(1);
        expect(exchange).to.have.callCount(1);
      });
    });
  });

  describe('exchangeBooking', () => {
    it('should check functions to be called', () => {
      const getUniversalRecordByPNR = sinon.spy(
        () => Promise.resolve(getURbyPNRSampleTicketed)
      );

      const exchange = sinon.spy(({ exchangeToken, uapi_reservation_locator: locator }) => {
        expect(exchangeToken).to.be.equal('token');
        expect(locator).to.be.equal('ABCDEF');
      });

      const airService = () => ({
        exchangeBooking: exchange,
        getUniversalRecordByPNR,
      });

      const createAirService = proxyquire('../../src/Services/Air/Air', {
        './AirService': airService,
      });

      const service = createAirService({ auth });

      return service.exchangeBooking({
        exchangeToken: 'token',
        pnr: 'PNR001',
      }).then(() => {
        expect(getUniversalRecordByPNR).to.have.callCount(1);
        expect(exchange).to.have.callCount(1);
      });
    });
  });

  describe('fareRules', () => {
    it('should check function to be called', () => {
      const fetch = sinon.spy(({ segments, passengers, fetchFareRules }) => {
        expect(segments).to.be.an('array');
        expect(segments).to.have.length(0);
        expect(passengers).to.be.an('object'); // add one fake passenger
        expect(passengers).to.have.all.keys('ADT');
        expect(passengers.ADT).to.equal(1);
        assert(fetchFareRules, 'fetchFareRules is necessary for underlying call');

        return Promise.resolve([
          {
            RuleNumber: '123',
            Source: 'ATPC',
            TariffNumber: 'Test',
            Rules: [],
          },
        ]);
      });

      const airService = () => ({
        lookupFareRules: fetch,
      });

      const createAirService = proxyquire('../../src/Services/Air/Air', {
        './AirService': airService,
      });

      const service = createAirService({ auth });

      return service.fareRules({
        segments: [],
        passengers: {
          ADT: 1,
        },
      }).then(() => {
        expect(fetch).to.have.callCount(1);
      });
    });
  });

  describe('pricing', () => {
    it('should check if correct function from service is called', () => {
      const airPrice = sinon.spy(() => {});
      const air = getAirServiceMock({ methods: { airPrice } });
      air.airPrice({});
      expect(airPrice.calledOnce).to.be.equal(true);
    });
  });
});
