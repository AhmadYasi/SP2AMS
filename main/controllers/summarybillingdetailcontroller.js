import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const getbillingdetails = async (req, res) => {
    try {
        const { generationDate } = req.query;

        const billRecords = await prisma.generatedBillRecord.findMany({
            where: {
                generation_date: new Date(generationDate)
            },
            include: {
                RoomBaseDetails: {
                    include: {
                        tenants: true,
                    }
                },
                Bill: true
            }
        });

        const paymentDetails = billRecords.map(record => {

            if (!record.RoomBaseDetails.tenants || record.RoomBaseDetails.tenants.length === 0) {
                console.log(`No tenants found for RoomBaseDetails ID: ${record.RoomBaseDetails.room_id}`);
                return {
                    room_id: record.RoomBaseDetails.room_id,
                    room_number: record.RoomBaseDetails.room_number,
                    tenant_name: 'No tenant',
                    total_bill: record.Bill ? record.Bill.total_amount : 'N/A',
                    // payment_status: record.payment_status,
                    id: record.bill_record_id,
                    // invoice_option: 'N/A'
                };
            }

            const tenant = record.RoomBaseDetails.tenants[0];
            const bill = record.Bill;

            return {
                room_id: record.RoomBaseDetails.room_id,
                room_number: record.RoomBaseDetails.room_number,
                tenant_name: `${tenant.first_name} ${tenant.last_name}`,
                total_bill: bill ? bill.total_amount : 'N/A',
                payment_status: record.payment_status,
                id: record.bill_record_id,
                invoice_option: tenant.invoice_option
            };
        });

        res.status(200).json({ message: 'Payment Details retrieved successfully', paymentDetails });
        console.log("Payment Details:", paymentDetails);

    } catch (error) {
        console.error('Error fetching payment details:', error);
        res.status(500).send(error.message);
    }
};

const getRoomBillingDetails = async (req, res) => {
    try {
        const { room_id } = req.params;

        const roomDetails = await prisma.roomBaseDetails.findUnique({
            where: {
                room_id: parseInt(room_id),
            },
            include: {
                tenancy_records: {
                    include: {
                        tenants: true,
                    },
                },
                bills: {
                    orderBy: {
                        billing_date: 'desc',
                    },
                    take: 1,
                },
                meter_readings: {
                    orderBy: {
                        reading_date: 'desc',
                    },
                    take: 1,
                },
                room_rates: {
                    include: {
                        rates: true,
                    },
                },
                generatedBillRecords: {
                    orderBy: {
                        generation_date: 'desc',
                    },
                    take: 1,
                },
            },
        });

        if (!roomDetails) {
            return res.status(404).json({ message: 'Room details not found' });
        }

        const activeTenant = roomDetails.tenancy_records[0]?.tenants || null;
        const billDetails = roomDetails.bills[0] || null;
        const meterDetails = roomDetails.meter_readings[0] || null;
        const generatedBillRecord = roomDetails.generatedBillRecords[0] || null;

        const detailedBilling = {
            room_number: roomDetails.room_number,
            tenant_name: activeTenant ? `${activeTenant.first_name} ${activeTenant.last_name}` : 'No Tenant',
            generation_date: generatedBillRecord ? generatedBillRecord.generation_date : 'N/A',
            total_bill: billDetails ? billDetails.total_amount : 'N/A',
            items: roomDetails.room_rates.map(rate => ({
                rate_id: rate.rates.rate_id,
                item_name: rate.rates.item_name,
                per_unit_price: rate.rates.item_price,
                quantity: rate.quantity,
                total: rate.quantity * rate.rates.item_price,
                last_updated: rate.rates.last_updated,
            })),
            meter_reading: {
                water_reading: meterDetails ? meterDetails.water_reading : 'N/A',
                electricity_reading: meterDetails ? meterDetails.electricity_reading : 'N/A',
                water_usage: billDetails ? billDetails.water_usage : 'N/A',
                water_cost: billDetails ? billDetails.water_cost : 'N/A',
                electricity_usage: billDetails ? billDetails.electricity_usage : 'N/A',
                electricity_cost: billDetails ? billDetails.electricity_cost : 'N/A',
                reading_date: meterDetails ? meterDetails.reading_date : 'N/A',
            },
        };

        res.status(200).json({ message: 'Room billing details retrieved successfully', detailedBilling, bill_id: billDetails.bill_id, room_id: billDetails.room_id });
    } catch (error) {
        console.error('Error fetching room billing details:', error);
        res.status(500).send(error.message);
    }
};

const applyTemporaryRateAdjustment = async (req, res) => {
    const { rate_id, room_id, bill_id, temporary_price } = req.body;

    try {
        const adjustment = await prisma.temporaryRateAdjustments.upsert({
            where: {
                rate_id_room_id_bill_id: {
                    rate_id: rate_id,
                    room_id: room_id,
                    bill_id: bill_id,
                },
            },
            update: {
                temporary_price: temporary_price,
                applied: false,
            },
            create: {
                rate_id: rate_id,
                room_id: room_id,
                bill_id: bill_id,
                temporary_price: temporary_price,
                applied: false,
            },
        });

        return res.status(200).json({ message: 'Temporary rate adjustment applied successfully', adjustment });
    } catch (error) {
        console.error('Error applying temporary rate adjustment:', error);
        return res.status(500).json({ message: 'Error applying temporary rate adjustment', error });
    }
};

const recalculateAndUpdateBill = async (req, res) => {
    const { bill_id, previousWaterReading,
        previousElectricityReading,
        currentWaterReading,
        currentElectricityReading } = req.body;

    console.log(`Recalculating bill for bill_id: ${bill_id}`);

    try {
        const updatedBill = await prisma.$transaction(async (prisma) => {
            const existingBill = await prisma.bills.findUnique({
                where: { bill_id: bill_id },
            });

            console.log(`Existing bill: ${JSON.stringify(existingBill)}`);

            if (!existingBill) {
                throw new Error('Bill not found');
            }

            const roomDetails = await prisma.roomBaseDetails.findUnique({
                where: { room_id: existingBill.room_id },
            });

            console.log(`Room details: ${JSON.stringify(roomDetails)}`);

            if (!roomDetails) {
                throw new Error('Room details not found for the bill');
            }

            const rolloverWater = 10000;
            const rolloverElectricity = 1000000;

            const newWaterUsage = currentWaterReading < previousWaterReading
                ? (currentWaterReading + rolloverWater) - previousWaterReading
                : currentWaterReading - previousWaterReading;
            const newElectricityUsage = currentElectricityReading < previousElectricityReading
                ? (currentElectricityReading + rolloverElectricity) - previousElectricityReading
                : currentElectricityReading - previousElectricityReading;


            if (newWaterUsage !== 0 || newElectricityUsage !== 0) {
                await prisma.meter_readings.create({
                    data: {
                        room_id: existingBill.room_id,
                        water_reading: currentWaterReading,
                        electricity_reading: currentElectricityReading,
                        reading_date: new Date(),
                    }
                });
            }


            let updatedTotalAmount = Number(roomDetails.base_rent);
            console.log(`Initial total amount (base rent): ${updatedTotalAmount}`);

            const adjustments = await prisma.temporaryRateAdjustments.findMany({
                where: { bill_id: bill_id, applied: false },
            });

            const roomRates = await prisma.room_rates.findMany({
                where: { room_id: existingBill.room_id },
                include: { rates: true }
            });

            let additionalRatesTotal = 0;
            let newWaterCost = 0;
            let newElectricityCost = 0;

            roomRates.forEach(roomRate => {
                const adjustment = adjustments.find(a => a.rate_id === roomRate.rate_id);
                let price = Number(adjustment ? adjustment.temporary_price : roomRate.rates.item_price);
                let totalForRate;


                if (roomRate.rates.item_name === "Water") {
                    newWaterCost = newWaterUsage * price
                    totalForRate = newWaterCost
                } else if (roomRate.rates.item_name === "Electricity") {
                    newElectricityCost = newElectricityUsage * price
                    totalForRate = newElectricityCost

                } else {
                    totalForRate = price * Number(roomRate.quantity);
                    additionalRatesTotal += totalForRate;

                }

                updatedTotalAmount += totalForRate;
            });

            console.log(`Final updatedTotalAmount: ${updatedTotalAmount}`);

            const updatedBill = await prisma.bills.update({
                where: { bill_id: bill_id },
                data: {
                    water_usage: newWaterUsage,
                    water_cost: newWaterCost,
                    electricity_usage: newElectricityUsage,
                    electricity_cost: newElectricityCost,
                    additional_rates_cost: additionalRatesTotal,
                    total_amount: updatedTotalAmount
                }
            });

            for (const adjustment of adjustments) {
                await prisma.temporaryRateAdjustments.update({
                    where: { temp_adjustment_id: adjustment.temp_adjustment_id },
                    data: { applied: true }
                });
            }
            return updatedBill;
        });

        res.json(updatedBill);
    } catch (error) {
        console.error('Error in recalculateAndUpdateBill:', error);
        res.status(500).json({ error: error.message });
    }
};


export { getbillingdetails, getRoomBillingDetails, applyTemporaryRateAdjustment, recalculateAndUpdateBill };