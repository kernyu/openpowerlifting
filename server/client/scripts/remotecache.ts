// vim: set ts=4 sts=4 sw=4 et:
//
// This file is part of OpenPowerlifting, an open archive of powerlifting data.
// Copyright (C) 2019 The OpenPowerlifting Project.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

// Data store for the SlickGrid on the Rankings page.
//
// The data is initially seeded through the HTML request,
// with further updates provided by AJAX calls, dispatched
// on scroll.

'use strict';

// Provided by the rankings template.
declare const urlprefix: string;

// Column mapping for the server rankings JSON.
//
// This must match the serialization of the JsEntryRow in the Rust server source.
export const enum Column {
    SortedIndex,
    Rank,
    Name,
    Username,
    Instagram,
    Color,
    Flair,
    LifterCountry,
    LifterState,
    Federation,
    Date,
    MeetCountry,
    MeetState,
    Path,
    Sex,
    Equipment,
    Age,
    Division,
    Bodyweight,
    WeightClass,
    Squat,
    Bench,
    Deadlift,
    Total,
    Points,
}

// Parameters for a possible remote request.
export interface WorkItem {
    startRow: number;  // Inclusive.
    endRow: number;  // Inclusive.
}

// Data that should be remembered about an AJAX request.
interface AjaxRequest {
    handle: XMLHttpRequest;
    item: WorkItem;
}

// Creates a data provider for the SlickGrid that understands how to
// make AJAX requests to a JSON endpoint to gather missing data.
export function RemoteCache(
    magicVersion: string,  // Unique checksum of database, for versioning.
    initialJson,  // Initial data, in the HTML to avoid a round-trip.
    selection: string,  // Selection string, for forming AJAX URLs.
    language: string,  // Language code, for including in AJAX requests.
    units: string  // Units, for including in AJAX requests.
) {
    const REQUEST_LENGTH = 100;  // Batch this many rows in one request.
    const AJAX_TIMEOUT = 50;  // Milliseconds before making AJAX request.

    let rows: ((string | number)[])[] = [];  // Array of cached row data.
    let length: number = 0;
    let hadFirstLoad = false;

    let activeTimeout: number | null = null;  // Timeout before making AJAX request.
    let activeAjaxRequest: AjaxRequest | null = null;

    // The viewport can update while the AJAX request is still ongoing.
    // The request is still allowed to finish, but it might have to
    // make another request with the pendingItem upon completion.
    let pendingItem: WorkItem | null = null;

    const onDataLoading = new Slick.Event();  // Data is currently loading.
    const onDataLoaded = new Slick.Event();  // Data has finished loading.
    const onFirstLoad = new Slick.Event();  // An initial AJAX request finished.

    function getLength(): number {
        return length;
    }

    // Single definition point for defining the URL endpoint.
    function makeApiUrl(item: WorkItem): string {
        const startRow = Math.max(item.startRow, 0);
        const endRow = item.endRow;
        return `${urlprefix}api/rankings${selection}?start=${startRow}&end=${endRow}&lang=${language}&units=${units}`;
    }

    // Given more JSON data, add it to the rows array.
    function addRows(json): void {
        length = json.total_length;
        if (json.rows instanceof Array) {
            for (let i = 0; i < json.rows.length; ++i) {
                const source: (string | number)[] = json.rows[i];
                const index = source[Column.SortedIndex] as number;
                rows[index] = source;
            }
        }
    }

    // Cancels any pending AJAX calls, but does not cancel ongoing ones.
    function cancelPendingRequests() {
        if (activeTimeout !== null) {
            clearTimeout(activeTimeout);
            activeTimeout = null;
        }
        pendingItem = null;
    }

    // Terminates any active AJAX calls and cancels any pending ones.
    function terminateActiveRequests() {
        if (activeAjaxRequest !== null) {
            activeAjaxRequest.handle.abort();
            activeAjaxRequest = null;
        }
        cancelPendingRequests();
    }

    // Ask for more data than is actually needed to cut down on the
    // number of requests.
    function maximizeItem(item: WorkItem): WorkItem {
        let startRow = item.startRow;
        let endRow = item.endRow;

        while (endRow - startRow + 1 < REQUEST_LENGTH
               && endRow < length - 1
               && rows[endRow] === undefined)
        {
            ++endRow;
        }

        // Now try the other direction: this handles the scrolling-up case.
        while (endRow - startRow + 1 < REQUEST_LENGTH
               && startRow > 0
               && rows[startRow] === undefined)
        {
            --startRow;
        }

        return { startRow: startRow, endRow: endRow };
    }

    // Function called by the timeout handler.
    function makeAjaxRequest(): void {
        // This function was called by the timeout handler.
        activeTimeout = null;

        // Sanity checking: if there's already an active AJAX request,
        // it should just be allowed to finish. When it finishes,
        // it will automatically queue the next request.
        if (activeAjaxRequest !== null) {
            return;
        }

        // Sanity checking: we have to arrive here with some work to do.
        if (pendingItem === null) {
            return;
        }

        // Pop the pendingItem.
        // Ask for as much data in the single request as possible.
        const item = maximizeItem(pendingItem);
        pendingItem = null;

        let handle = new XMLHttpRequest();
        handle.open("GET", makeApiUrl(item));
        handle.responseType = "json";
        handle.addEventListener("load", function(e) {
            // Can't happen: appeases TypeScript.
            if (activeAjaxRequest === null) {
                return;
            }

            addRows(activeAjaxRequest.handle.response);
            activeAjaxRequest = null;
            if (hadFirstLoad === true) {
                onDataLoaded.notify(item);
            } else {
                onFirstLoad.notify(item);
                hadFirstLoad = true;
            }

            // Ensure any pendingItem is resolved if necessary.
            if (pendingItem !== null && activeTimeout === null) {
                const item = pendingItem;
                pendingItem = null;
                ensureData(item);
            }
        });
        handle.addEventListener("error", function(e) {
            console.log(e);
            activeAjaxRequest = null;
            onDataLoaded.notify(item);
        });

        activeAjaxRequest = { handle: handle, item: item };
        activeAjaxRequest.handle.send();

        // Notify that we've started loading some data.
        onDataLoading.notify(item);
    }

    // Forcibly load the data in the given inclusive range,
    // without bounds checking.
    function forceData(item: WorkItem): void {
        // Ensure that an AJAX request will be made.
        pendingItem = item;
        if (activeTimeout === null) {
            activeTimeout = window.setTimeout(makeAjaxRequest, AJAX_TIMEOUT);
        }
    }

    // Check that the data in the given inclusive range is loaded.
    // If not, arrange an AJAX request to load it.
    // This is the main function that does work.
    function ensureData(item: WorkItem): void {
        // Ensure sane bounds.
        let startRow = Math.max(item.startRow, 0);
        let endRow = Math.min(item.endRow, length - 1);

        // Find the closest row that hasn't been filled in.
        while (startRow < endRow && rows[startRow] !== undefined) {
            ++startRow;
        }

        // Find the farthest row that hasn't been filled in.
        while (startRow < endRow && rows[endRow] !== undefined) {
            --endRow;
        }

        // If everything has already been filled in, we're done!
        if (startRow > endRow || ((startRow == endRow) && rows[startRow] !== undefined)) {
            onDataLoaded.notify({startRow: startRow, endRow: endRow});
            return;
        }

        forceData({ startRow: startRow, endRow: endRow });
    }

    // Initialization.
    if (initialJson !== null) {
        hadFirstLoad = true;
        addRows(initialJson);
    }

    return {
        // Properties.
        "rows": rows,
        "getLength": getLength,

        // Methods.
        "ensureData": ensureData,
        "forceData": forceData,
        "terminateActiveRequests": terminateActiveRequests,

        // Events.
        "onDataLoading": onDataLoading,
        "onDataLoaded": onDataLoaded,
        "onFirstLoad": onFirstLoad
    };
}
