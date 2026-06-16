package com.net2app.gateway;

/**
 * Maps phone number prefixes to MCC/MNC codes for SMS routing.
 * Mirrors the logic in the Next.js API's getMccMnc() and Python gateway's get_mcc_mnc().
 */
public class MccMncLookup {

    /** Returns {mcc, mnc, mccMnc} for a phone number prefix. */
    public static MccMncResult lookup(String phoneNumber) {
        if (phoneNumber == null) return EMPTY;
        String c = phoneNumber.replaceAll("^00", "").replaceAll("^\\+", "");
        
        if (c.startsWith("880")) return new MccMncResult("470", "01", "47001");
        if (c.startsWith("91"))  return new MccMncResult("404", "68", "40468");
        if (c.startsWith("251")) return new MccMncResult("636", "01", "63601");
        if (c.startsWith("1"))   return new MccMncResult("310", "410", "310410");
        if (c.startsWith("44"))  return new MccMncResult("234", "30", "23430");
        if (c.startsWith("92"))  return new MccMncResult("410", "01", "41001");
        
        return EMPTY;
    }

    private static final MccMncResult EMPTY = new MccMncResult("", "", "");

    public record MccMncResult(String mcc, String mnc, String mccMnc) {}
}
