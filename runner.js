/*jshint loopfunc: true */

(function () {
    'use strict';

    var util = require('util');
    var child_process = require('child_process');
    var exec = require('child_process').spawnSync;
    var xml2js = require('xml2js');
    var parser = new xml2js.Parser();
    var fs = require('fs');
    var MongoClient = require('mongodb').MongoClient;
    var cipherInfo = require('./mapCiphers');

    var filename = "top-7k.txt";
    var domains; // the domains collection
    var scans; // the scans collection


    // connect to mongodb
    MongoClient.connect("mongodb://localhost:27017/czTls", function(err, db) {
        if (!err) {
            // here we are going to save our temporary files
            child_process.execSync('mkdir -p tmp', { encoding: 'utf8' });
            domains = db.collection('domains');
            scans = db.collection('scans');
            workOnNextDomain(db);
        }
    });

    var workOnNextDomain = function(db) {
        // receive a domain from mongoDB
        var line = 'google.de';
        domains.findOne({wip: false}, {sort: "lastScanDate"}, function(err, document) {
            if (err) console.log(err);

            // mark this domain as WIP
            domains.updateOne(
                { domain : document.domain },
                {
                    $set: { wip: true },
                },
                function(err, results) {
                    // now start the scan on this domain
                    scan(document.domain, db);
                }
            );
        });
    };

    var scan = function(domain, db) {
        var xmlFileName = util.format('tmp/%s.xml', domain);
        var pemFileName = util.format('tmp/%s.pem', domain);
        var sslScanCmd = './sslscan';
        var sslScanArgs = util.format('--no-heartbleed --xml=%s %s', xmlFileName, domain);

        // execute SSLScan
        console.log('\n', domain, "➡ starting SSLScan");
        var output = exec('./sslscan', ['--no-heartbleed', util.format('--xml=%s', xmlFileName), domain], { encoding: 'utf8' });

        if (output.stderr.length > 0) {
            // SSLScan executed with errors errors
            // TODO: write to error in some way to DB
            console.log(domain, "𝗫 SSLScan had problems on this url:", output.stderr);
            workOnNextDomain(db);
        } else {
            // SSLScan executed without errors
            try {
                // read the xml and parse it to json
                var xmlFile = fs.readFileSync(xmlFileName, "utf8");
                parser.parseString(xmlFile, function(err, result) {
                    if (err) console.log("parseErr", err);

                    // setup our scan object, we save this to the DB
                    var scan = {
                        source: filename,
                        date: new Date(),
                        domain: domain,
                        ciphers: [],
                        certificate: {}
                    };

                    // get some more certificate information via OpenSLL
                    var publicKeyAlgorithm = '';
                    var publicKeyLength = 0;

                    // receive certificate
                    var receiveCertCmd = util.format('openssl s_client -connect %s:443 </dev/null 2>/dev/null | openssl x509 -outform PEM > %s', domain, pemFileName);
                    child_process.execSync(receiveCertCmd, { encoding: 'utf8' });

                    // view the cert with x509
                    var readCertCmnd = util.format('openssl x509 -text -noout -in %s', pemFileName);
                    var x509Output = child_process.execSync(readCertCmnd, { encoding: 'utf8' });

                    // no wrestle through the x509 output and collect our data (algo & keylength)
                    var algoPattern = 'Public Key Algorithm: ';
                    var algoPos = x509Output.indexOf(algoPattern) + algoPattern.length;
                    var lineEndPos = x509Output.indexOf('\n',algoPos);
                    publicKeyAlgorithm = x509Output.substring(algoPos, lineEndPos);

                    // no get the key size
                    var followingLine = x509Output.substring(lineEndPos, x509Output.indexOf('\n',lineEndPos+1)).trim();
                    var publicKeyKeylengthAsString = followingLine.substring(followingLine.indexOf('(')+1, followingLine.indexOf(' bit)'));
                    publicKeyLength = parseInt(publicKeyKeylengthAsString);

                    console.log(domain, '✔︎ Public Key:', publicKeyAlgorithm, publicKeyLength);

                    // add cert informations
                    // TODO: remove the ifs by monads http://blog.osteele.com/posts/2007/12/cheap-monads/
                    if (result.document.ssltest[0].certificate[0].altnames)
                        scan.certificate.altnames = result.document.ssltest[0].certificate[0].altnames[0];
                    scan.certificate.expired = result.document.ssltest[0].certificate[0].expired[0];
                    scan.certificate.issuer = result.document.ssltest[0].certificate[0].issuer[0];
                    scan.certificate.notValidAfter = result.document.ssltest[0].certificate[0]['not-valid-after'][0];
                    scan.certificate.notValidBefore = result.document.ssltest[0].certificate[0]['not-valid-before'][0];
                    scan.certificate.signatureAlgorithm = result.document.ssltest[0].certificate[0]['signature-algorithm'][0];
                    scan.certificate.publicKeyAlgorithm = publicKeyAlgorithm;
                    scan.certificate.publicKeyLength = publicKeyLength;
                    scan.certificate.subject = result.document.ssltest[0].certificate[0].subject[0];

                    // collect all the ciphers suites
                    console.log(domain ,"✔︎ found ", result.document.ssltest[0].cipher.length, " ciphers");
                    for (var i = 0; i < result.document.ssltest[0].cipher.length; i++) {
                        var cipher = result.document.ssltest[0].cipher[i].$;

                        cipher.protocol = cipher.sslversion;
                        delete cipher.sslversion;

                        // get some additional cipher info (actualy its informations from the tls specs)
                        var additionalCipherInfo = cipherInfo.getCipherInfos(cipher.cipher);
                        if (additionalCipherInfo) {
                            cipher.kx = additionalCipherInfo.kx;
                            cipher.kxStrenght = scan.certificate.publicKeyLength;
                            if (cipher.ecdhebits) { cipher.kxStrenght = cipher.ecdhebits; delete cipher.ecdhebits; }
                            if (cipher.dhebits) { cipher.kxStrenght = cipher.dhebits; delete cipher.dhebits; }
                            cipher.au = additionalCipherInfo.au;
                            cipher.enc = additionalCipherInfo.enc;
                            cipher.mac = additionalCipherInfo.mac;
                            cipher.export = additionalCipherInfo.export;
                        }
                        scan.ciphers.push(cipher);
                    }

                    // insert the new scan into DB
                    scans.insert(scan, function(err, doc){
                        if (err) {
                            console.log("Error while inserting the new Scan", err);
                        } else {
                            console.log(domain, "✔︎ new scan successfully inserted in DB", doc.insertedIds);
                        }
                    });

                    // remove WIP flag and move to next domain
                    domains.updateOne(
                        { domain : domain },
                        {
                            $set: {
                                wip: false,
                                lastScanDate: new Date()
                            },
                        },
                        function(err, results) {
                            if (err) {
                                console.log(domain, "Error while removing WIP flag", err);
                            } else {
                                console.log(domain, "✔︎ WIP flag succesfully removed");
                            }
                        }
                    );

                    // delete the from SSLScan generated xml file
                    child_process.execSync(util.format("rm -f %s", xmlFileName), { encoding: 'utf8' });

                    // delete the downloaded certificate
                    child_process.execSync(util.format("rm -f %s", pemFileName), { encoding: 'utf8' });
                });
            } catch (e) {
                console.log(domain, "𝗫 JSERR", JSON.stringify(e).substring(0,100));
            } finally {
                // work on the next document
                workOnNextDomain(db);
            }
        }
    };
}());
