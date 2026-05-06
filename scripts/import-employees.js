/**
 * Quecko TRS — Employee Import Script
 * ------------------------------------
 * 1. Wipes all data except admins + admin_sessions + leave_policies
 * 2. Imports real employee records (no invites, no passwords set)
 *
 * Run inside the backend container:
 *   node scripts/import-employees.js
 */

require('dotenv').config();
const mysql  = require('mysql2/promise');
const crypto = require('crypto');

// ── DB Connection ─────────────────────────────────────────────────────────────
const pool = mysql.createPool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     process.env.DB_PORT     || 3306,
  user:     process.env.DB_USER     || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME     || 'queckots',
  waitForConnections: true,
  connectionLimit: 10,
});

// ── Date Parser ───────────────────────────────────────────────────────────────
function parseDate(str) {
  if (!str || str.trim() === '') return null;
  str = str.trim();

  const months = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };

  // Remove ordinal suffixes: 1st, 2nd, 3rd, 4th, 16th, etc.
  str = str.replace(/(\d+)(st|nd|rd|th)/gi, '$1').trim();

  // DD-Mon-YY(YY) or DD Mon YYYY  e.g. 10-May-88, 01-Mar-20, 28 Mar 1997
  let m = str.match(/^(\d{1,2})[\s\-]([A-Za-z]+)[\s\-](\d{2,4})$/);
  if (m) {
    const day = parseInt(m[1]);
    const mon = months[m[2].toLowerCase().substring(0, 3)];
    let year = parseInt(m[3]);
    if (!mon) return null;
    if (year < 100) year += year < 30 ? 2000 : 1900;
    return `${year}-${String(mon).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
  }

  // Numeric: DD/MM/YYYY, MM/DD/YYYY, M-DD-YYYY, DD-MM-YYYY, YYYY-MM-DD
  m = str.match(/^(\d{1,4})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m) {
    let p1 = parseInt(m[1]), p2 = parseInt(m[2]), p3 = parseInt(m[3]);

    // YYYY-MM-DD
    if (p1 > 31) {
      return `${p1}-${String(p2).padStart(2,'0')}-${String(p3).padStart(2,'0')}`;
    }

    let year = p3 < 100 ? (p3 < 30 ? 2000 + p3 : 1900 + p3) : p3;

    let day, mon;
    if (p1 > 12)      { day = p1; mon = p2; }  // p1 can't be month → DD/MM
    else if (p2 > 12) { mon = p1; day = p2; }  // p2 can't be day   → MM/DD
    else              { day = p1; mon = p2; }  // ambiguous → default DD/MM (Pakistan)

    return `${year}-${String(mon).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
  }

  return null;
}

// ── Employee Data ─────────────────────────────────────────────────────────────
const employees = [
  { fn:'Muhammad Alee',    ln:'Abbasi',        father:'Masroor Abbasi',           email:'aleeabbasi021@gmail.com',         gender:'Male',   dob:'10-May-88',      cnic:'61101-4029607-7',   join:'01-Mar-20',   role:'CEO' },
  { fn:'Anosha',           ln:'Noor',          father:'Noor Muhammad',            email:'anoshanoor363@gmail.com',         gender:'Female', dob:'14-Feb-00',      cnic:null,                join:'28-Aug-25',   role:'HR Specialist' },
  { fn:'Laiba',            ln:'Arshad',        father:'Arshad Hussain',           email:'laibaarshad617@gmail.com',        gender:'Female', dob:'20-Oct-02',      cnic:'61101-2906892-0',   join:'03-Oct-25',   role:'HR Specialist' },
  { fn:'Waleed',           ln:'Qureshi',       father:'Muhammad Shafique',        email:'waleed.shafiq96@gmail.com',       gender:'Male',   dob:'29-Nov-96',      cnic:'37405-5370207-7',   join:'01-Oct-20',   role:'CTO' },
  { fn:'Muhammad',         ln:'Waqas',         father:'Muhammad Bashir',          email:'mwaqasbashir4@gmail.com',         gender:'Male',   dob:'31-Dec-96',      cnic:'31101-2615995-3',   join:'01-Nov-21',   role:'Senior Blockchain Developer' },
  { fn:'Usama',            ln:'Saif',          father:'Saif ur Rehman',           email:'usamasaif772@gmail.com',          gender:'Male',   dob:'27/01/1998',     cnic:'37405-5319756-1',   join:'07-Sept-22',  role:'Backend Developer' },
  { fn:'Saif',             ln:'Ur Rehman',     father:'Abdul Rehman',             email:'saifurehman980@gmail.com',        gender:'Male',   dob:'09-Jun-96',      cnic:'82203-1525042-1',   join:'05-Oct-22',   role:'Backend Developer' },
  { fn:'Faheem',           ln:'Ahmed',         father:'Javed Akhtar Minhas',      email:'afaheem295@gmail.com',            gender:'Male',   dob:'02-Oct-94',      cnic:'37405-9531704-5',   join:'05-Dec-22',   role:'Backend Developer' },
  { fn:'Abdul Rehman',     ln:'Sohail',        father:'M Sohail Zulfi',           email:'adrehman11@gmail.com',            gender:'Male',   dob:'17-Nov-97',      cnic:'31202-2687951-3',   join:'14-Mar-22',   role:'Backend Developer' },
  { fn:'Ammar',            ln:'Salahuddin',    father:'Salahuddin Qureshi',       email:'ammarsjw@gmail.com',              gender:'Male',   dob:'28th Mar 1997',  cnic:'41303-7993637-1',   join:'29-Mar-22',   role:'Senior Blockchain Developer' },
  { fn:'Afaq',             ln:'Ahsan',         father:'M Irfan',                  email:'afaqahsan23@gmail.com',           gender:'Male',   dob:'11/12/1998',     cnic:'34601-2961300-9',   join:'07/03/2023',  role:'Blockchain Developer' },
  { fn:'Muhammad',         ln:'Shoaib',        father:'M Shoukat',                email:'3445shoaib@gmail.com',            gender:'Male',   dob:'03/05/1997',     cnic:'82203-0987357-5',   join:'7/18/2023',   role:'Backend Developer' },
  { fn:'Muhammad',         ln:'Shahid',        father:'Saleem pervez',            email:'contacttoshahidkhan@gmail.com',   gender:'Male',   dob:'7/19/2000',      cnic:'42201-8594865-3',   join:'08/10/2023',  role:'Backend Developer' },
  { fn:'Akash',            ln:'Sabir',         father:'Sabir Hussain',            email:'akashsabir007@gmail.com',         gender:'Male',   dob:'19/11/1995',     cnic:'13101-5604008-9',   join:'21-Feb-22',   role:'Senior Backend Developer' },
  { fn:'Rubab',            ln:'Babar',         father:'Azhar Ali Babar',          email:'rubabosama998@gmail.com',         gender:'Female', dob:'29/10/1998',     cnic:'35201-7144060-0',   join:'04-Mar-24',   role:'Blockchain Developer' },
  { fn:'Muhammad',         ln:'Mujahid Khan',  father:'Saleem Pervaiz Khan',      email:'immujahidkhan6@gmail.com',        gender:'Male',   dob:'07/08/1994',     cnic:'42201-8499865-3',   join:'03-Apr-24',   role:'Blockchain Developer' },
  { fn:'Ismat',            ln:'Batool',        father:'Arif Hussain',             email:'ibatool.63@gmail.com',            gender:'Female', dob:'22-Dec-95',      cnic:'37104-7893910-6',   join:'19-Nov-24',   role:'Backend Developer' },
  { fn:'Syed',             ln:'Asher',         father:'Syed Humayun Shah',        email:'syedtirimzi@gmail.com',           gender:'Male',   dob:'14/08/1997',     cnic:'13302-1778208-1',   join:'04/06/2023',  role:'Backend Developer' },
  { fn:'Muhammad',         ln:'Wasif',         father:'Sheikh Shahid Majeed',     email:'mwasifsheikh@gmail.com',          gender:'Male',   dob:'28-Jul-98',      cnic:'61101-1541518-7',   join:'29-Feb-24',   role:'Team Lead - Blockchain' },
  { fn:'Zulkefal',         ln:'Khan',          father:'Jehanzeb',                 email:'zulkefal.khan705@gmail.com',      gender:'Male',   dob:'02/12/2000',     cnic:'37101-7413415-5',   join:'02-Sept-24',  role:'Blockchain Developer' },
  { fn:'Abdullah',         ln:'Aslam',         father:'M Ashraf',                 email:'abdullahopl6@gmai.com',           gender:'Male',   dob:'16/08/1995',     cnic:'37405-3849658-5',   join:'16/09/2024',  role:'Sr. Backend Developer' },
  { fn:'Saifullah',        ln:'Omar',          father:'Noorshaid Ahmed',          email:'saifullahomar786@gmail.com',      gender:'Male',   dob:'17/11/2000',     cnic:'16101-2836608-1',   join:'20/11/2024',  role:'Blockchain Developer' },
  { fn:'Jawad',            ln:'Khan',          father:'Rafil Ullah Khan',         email:'jwad.khaan@gmail.com',            gender:'Male',   dob:'9/17/2004',      cnic:'35201-4661120-1',   join:'4-14-2025',   role:'Backend Developer' },
  { fn:'Muhammad Salman',  ln:'Azhar',         father:'Saeed Ahmad',              email:'salmanazhar.official@gmail.com',  gender:'Male',   dob:'07-Jan-97',      cnic:'36602-3342267-9',   join:'08-Oct-21',   role:'Sr. Backend Developer' },
  { fn:'Shahid',           ln:'Khan Niazi',    father:'Ghulam Abbas Khan',        email:'shahid.niazi.dev@gmail.com',      gender:'Male',   dob:'01/05/1998',     cnic:'38301-8212192-1',   join:'05-Nov-25',   role:'Sr. Blockchain Backend Developer' },
  { fn:'Absar',            ln:'Salahuddin',    father:'Salahuddin Qureshi',       email:'absarsdq291@gmail.com',           gender:'Male',   dob:'29-Jan-00',      cnic:'41303-4187813-7',   join:'03-Nov-25',   role:'Jr. Blockchain Developer' },
  { fn:'Hamza',            ln:'Khalid Khan',   father:'Khalid Mahmood Khan',      email:'hamzakhalidkhan.13@gmail.com',    gender:'Male',   dob:'16/11/1996',     cnic:'61101-2725536-1',   join:'21/11/2024',  role:'Blockchain Developer' },
  { fn:'Usman',            ln:'Aslam Malik',   father:'M Aslam',                  email:'usman.maliknu13@gmail.com',       gender:'Male',   dob:'04-Aug-93',      cnic:'34104-1265917-9',   join:'18-Jun-20',   role:'Team Lead Frontend' },
  { fn:'Muhammad',         ln:'Jawad',         father:'M Anwar',                  email:'chudhryjawad@gmail.com',          gender:'Male',   dob:'18-Aug-98',      cnic:'37101-6407985-9',   join:'15-Nov-21',   role:'Sr. Frontend Developer' },
  { fn:'Muhammad',         ln:'Awais',         father:'M Irshad',                 email:'m.awais.genius@gmail.com',        gender:'Male',   dob:'05-Jun-00',      cnic:'34501-1824915-7',   join:'01-Aug-22',   role:'Front-end Developer' },
  { fn:'Muhammad Abdullah',ln:'Anwar',         father:'Anwar Ul Haq',             email:'abdullah157a157a@gmail.com',      gender:'Male',   dob:'04-Jan-96',      cnic:'31303-5555864-5',   join:'09-May-22',   role:'Sr. Frontend Developer' },
  { fn:'Sardar Shahzeb',   ln:'Naseer',        father:'Sardar Naseer M',          email:'shahzeb.naseer2@gmail.com',       gender:'Male',   dob:'18-Mar-96',      cnic:'13101-5336396-9',   join:'26-Jan-21',   role:'Sr. Frontend Blockchain Developer' },
  { fn:'Aman',             ln:'Ullah',         father:'Sheikh M Umer',            email:'amanullah07544@gmail.com',        gender:'Male',   dob:'26-Apr-96',      cnic:'37405-9544930-7',   join:'08-Dec-21',   role:'Sr. Frontend Blockchain Developer' },
  { fn:'Noor',             ln:'Imad',          father:'Imad',                     email:'noorimad274939@gmail.com',        gender:'Male',   dob:'17/07/1996',     cnic:'17301-4735816-1',   join:'04-Jul-22',   role:'Frontend Developer' },
  { fn:'Raza',             ln:'Awan',          father:'Abdul Ghaffar Awan',       email:'razaawanpersonal@gmail.com',      gender:'Male',   dob:'11/03/1998',     cnic:'37104-9283221-7',   join:'18/03/2025',  role:'Frontend Developer' },
  { fn:'Muhammad Yahya',   ln:'Rehman',        father:'Khalil Ahmed',             email:'yahyarehmanlfc@gmail.com',        gender:'Male',   dob:'03/07/1994',     cnic:'34201-3645725-1',   join:'21/04/2025',  role:'Frontend Developer' },
  { fn:'Muhammad',         ln:'Waleed',        father:'M Mushtaq',                email:'m.waleedapsacian@gmail.com',      gender:'Male',   dob:'04/01/2002',     cnic:'42000-5070531-3',   join:'18/11/2024',  role:'Front-end Developer' },
  { fn:'Abdul',            ln:'Basit',         father:'M Arshad Javed',           email:'iamabdulbasit0702@gmail.com',     gender:'Male',   dob:'21/10/2002',     cnic:'3330-16757629-3',   join:'28/11/2024',  role:'Front-end Developer' },
  { fn:'Muhammad Usama',   ln:'Shafique',      father:'M Shafique',               email:'usama_shafiq97@hotmail.com',      gender:'Male',   dob:'15/01/1997',     cnic:'37405-3133769-5',   join:'06/01/2025',  role:'Team Lead Frontend' },
  { fn:'Abdul',            ln:'Moiz',          father:'Aurang Zaib',              email:'moeezabdul2004@gmail.com',        gender:'Male',   dob:'7/29/2004',      cnic:'37405-1846251-7',   join:'07/06/2022',  role:'Frontend Developer' },
  { fn:'Muhammad Abdullah',ln:'Zahid',         father:'Mirza Zahid Mahmood',      email:'aabimirza231@gmail.com',          gender:'Male',   dob:'01/08/2000',     cnic:'37405-9963042-9',   join:'07/06/2022',  role:'Frontend Developer' },
  { fn:'Zahid',            ln:'Rahman',        father:'M Idrees',                 email:'codewithxohii@gmail.com',         gender:'Male',   dob:'01/04/1999',     cnic:'15101-6918488-3',   join:'10/03/2023',  role:'Frontend Developer' },
  { fn:'Usama',            ln:'Nawaz Chattha', father:'Afzaal Ahmad Chattha',     email:'osamachattha78@gmail.com',        gender:'Male',   dob:'27-Aug-92',      cnic:'38403-8387655-7',   join:'01-Jul-21',   role:'Team Lead QA' },
  { fn:'Sajjad',           ln:'Baig',          father:'Mirza Shoukat Ali Baig',   email:'sajjadbaig1227@gmail.com',        gender:'Male',   dob:'14/09/1994',     cnic:'33104-5832342-9',   join:'12-Sept-22',  role:'Quality Assurance Officer' },
  { fn:'Ibrahim',          ln:'Qureshi',       father:'M Imran Qureshi',          email:'ibrahimqureshi.m17@gmail.com',    gender:'Male',   dob:'17/08/1996',     cnic:'61101-9959205-9',   join:'04/12/2023',  role:'Quality Assurance Officer' },
  { fn:'Uzair',            ln:'Anwar',         father:'Khursheed Anwar',          email:'uzairanwar0306@gmail.com',        gender:'Male',   dob:'22/01/2000',     cnic:'13501-44161682-3',  join:'20-May-24',   role:'Quality Assurance Officer' },
  { fn:'Muhammad Shoaib',  ln:'Virk',          father:'Farman Ali',               email:'shoaibvirk24@gmail.com',          gender:'Male',   dob:'25/12/1997',     cnic:'34103-1630917-7',   join:'7/24/2023',   role:'Quality Assurance Officer' },
  { fn:'Fahad',            ln:'Saleem',        father:'Saleem Ur Rehman',         email:'fahadsaleemsqaa@gmail.com',       gender:'Male',   dob:'09/12/1999',     cnic:'32303-8066896-5',   join:'06/01/2024',  role:'Quality Assurance Officer' },
  { fn:'Haziq',            ln:'Ahmed Baig',    father:'Mirza Shakoor Ahmed',      email:'haziqahmed31971@gmail.com',       gender:'Male',   dob:'17/06/2001',     cnic:'37406-4192211-3',   join:'8/19/2024',   role:'Quality Assurance Officer' },
  { fn:'Uzair',            ln:'Ahsan',         father:'Tariq Afzal',              email:'uzairahsan999@gmail.com',         gender:'Male',   dob:'01/01/2001',     cnic:'37101-4400786-5',   join:'8/22/2024',   role:'Quality Assurance Officer' },
  { fn:'Muhammad',         ln:'Murtaza',       father:'Syed Rehbar Hassan Naqvi', email:'murtaza.naqvi301@gmail.com',      gender:'Male',   dob:'28/02/2001',     cnic:'17301-792830-3',    join:'18/09/2023',  role:'Quality Assurance Officer' },
  { fn:'Linta',            ln:'Binte Habib',   father:'Maj(R) Habib Qadir',       email:'lintabintehabib2002@gmail.com',   gender:'Female', dob:'16-Jan-02',      cnic:'37405-1408466-6',   join:'15-Sept-25',  role:'Jr. Quality Assurance Officer' },
  { fn:'Bilal',            ln:'Abdullah',      father:'Muhammad Sajid',           email:'bilalabdullah451@gmail.com',      gender:'Male',   dob:'19-Aug-02',      cnic:'37405-1114974-7',   join:'01-Dec-25',   role:'Jr. Quality Assurance Officer' },
  { fn:'Jamal',            ln:'Waseem',        father:'Mazhar Hussain Waseem',    email:'jamalwaseem13@gmail.com',         gender:'Male',   dob:'13-Sept-90',     cnic:'61101-8065205-3',   join:'01-Mar-20',   role:'Team Lead UI/UX Developer' },
  { fn:'Sardar Ahmad',     ln:'Naseem',        father:'Sardar M Naseem',          email:'sardarahmadnaseem@gmail.com',     gender:'Male',   dob:'11-May-86',      cnic:'13101-5027562-7',   join:'16-Dec-21',   role:'Sr. Frontend Developer' },
  { fn:'Usman',            ln:'Afzal',         father:'M Afzal',                  email:'usmanheer9@gmail.com',            gender:'Male',   dob:'22/06/2000',     cnic:'37405-1119542-7',   join:'16-May-22',   role:'Sr. UI/UX Developer' },
  { fn:'Hamza',            ln:'Iftikhar',      father:'Iftikhar Ahmed',           email:'hamzach625@gmail.com',            gender:'Male',   dob:'08/09/1999',     cnic:'31303-3047956-9',   join:'09-May-22',   role:'Sr. UI/UX Developer' },
  { fn:'Wardah',           ln:'Rehman',        father:'Abdur Rehman',             email:'wardahrehman703@gmail.com',       gender:'Female', dob:'27/08/2000',     cnic:'37201-3249761-2',   join:'01-Mar-24',   role:'Frontend Developer' },
  { fn:'Hamza',            ln:'Ellahi',        father:'Asif Elahi',               email:'hamzaval2000@gmail.com',          gender:'Male',   dob:'18/01/2005',     cnic:'61101-6388641-9',   join:null,          role:'Frontend Developer' },
  { fn:'Muhammad',         ln:'Hammad',        father:'M Anwar',                  email:'hammadanwar6520@gmail.com',       gender:'Male',   dob:'20/09/2004',     cnic:'32203-6972138-3',   join:'01/12/2024',  role:'Frontend Developer' },
  { fn:'Sharjeel',         ln:'Awan',          father:'Ghulam Haider Awan',       email:'sharjeelawan88@gmail.com',        gender:'Male',   dob:'20/07/1988',     cnic:'36302-9321977-5',   join:'07-Jun-21',   role:'Chief Product Officer' },
  { fn:'Umar Ali',         ln:'Butt',          father:'Ali Raza Butt',            email:'ub1894497@gmail.com',             gender:'Male',   dob:'17-Jan-05',      cnic:'61101-1601510-7',   join:'20-Sep-2021', role:'Senior Product Designer' },
  { fn:'Khawar',           ln:'Ali Ramzan',    father:'M Ramzan',                 email:'khawaraliramzan@gmail.com',       gender:'Male',   dob:'16-Dec-94',      cnic:'61101-5606055-7',   join:'01-Apr-20',   role:'Senior Product Designer' },
  { fn:'Asad',             ln:'Ullah 3D',      father:'Shabbir Hussain',          email:'asadbutt_1@hotmail.com',          gender:'Male',   dob:'13-Nov-99',      cnic:'34202-2230421-3',   join:'05-Apr-22',   role:'Associate Product Designer' },
  { fn:'Zahir',            ln:'Bakhash',       father:'Raziq Bakhash',            email:'zahirbakhash5@gmail.com',         gender:'Male',   dob:'08-Jul-05',      cnic:'61101-2713645-5',   join:'07-Sept-23',  role:'Associate Product Designer' },
  { fn:'Abu Bakkar',       ln:'Khan',          father:'M Dayar Khan',             email:'khan.shani99@gmail.com',          gender:'Male',   dob:'01/08/1998',     cnic:'61101-6053564-9',   join:'25-Apr-22',   role:'Senior Product Designer' },
  { fn:'Awais',            ln:'Raza',          father:'Muhammad Sarfraz',         email:'awaissarfa@gmail.com',            gender:'Male',   dob:'18-Oct-01',      cnic:'36502-8112767-3',   join:'06-Oct-25',   role:'Associate Product Designer' },
  { fn:'Muhammad Zia',     ln:'Ul Rehman',     father:'M Zaman',                  email:'zeekhan7872@gmail.com',           gender:'Male',   dob:'28-Dec-94',      cnic:'32304-6071017-9',   join:'01-Nov-21',   role:'Team Lead Mobile App' },
  { fn:'Adnan',            ln:'Saleem',        father:'Mohammad Saleem',          email:'adnankhan3937@gmail.com',         gender:'Male',   dob:'12/03/1997',     cnic:'82101-9901670-9',   join:'25-Apr-2022', role:'Senior Mobile App Developer' },
  { fn:'Muhammad',         ln:'Asjad',         father:'Wajid Mehmood',            email:'mughalaasjad577@gmail.com',       gender:'Male',   dob:'01/12/1998',     cnic:'37402-6827987-1',   join:'8/16/2023',   role:'Mobile App Developer' },
  { fn:'Abdul',            ln:'Basit',         father:'Shaukat Ali Awan',         email:'abdulrocker4@gmail.com',          gender:'Male',   dob:'26/07/2002',     cnic:'90406-0183513-1',   join:'6-16-2025',   role:'Jr. Mobile App Developer' },
  { fn:'Farhan',           ln:'Razzaq',        father:'Abdul Razzaq',             email:'farhanrazzaq57@gmail.com',        gender:'Male',   dob:'04/08/1997',     cnic:'34602-5703633-3',   join:'8/15/2023',   role:'Senior Mobile App Developer' },
  { fn:'Ateeq',            ln:'Ur Rehman',     father:'Abdul Shakoor',            email:'ateeq4112@gmail.com',             gender:'Male',   dob:'02-Jan-97',      cnic:'71301-0335180-5',   join:'28-Oct-25',   role:'Senior Mobile App Developer' },
  { fn:'Muhammad',         ln:'Shehryar',      father:'Allah Ditta',              email:'shehryarmuhammad97@gmail.com',    gender:'Male',   dob:'25-Dec-97',      cnic:'61101-2258406-7',   join:'15-Oct-25',   role:'Senior Mobile App Developer' },
  { fn:'Hamid',            ln:'Shehzad',       father:'Awal Khan',                email:'softwaresdeveloper143@gmail.com', gender:'Male',   dob:'16-Jan-95',      cnic:'17201-6651115-1',   join:'13-Oct-25',   role:'Senior Mobile App Developer' },
  { fn:'Muhammad',         ln:'Muzammil',      father:'Dil Nawaz Khan',           email:'mmuzammil.tech@gmail.com',        gender:'Male',   dob:'22-Dec-98',      cnic:'42401-9732865-1',   join:'20-Oct-25',   role:'Team Lead DevOps' },
  { fn:'Muhammad Nauman',  ln:'Hafeez',        father:'Hafeez Ur Rehman',         email:'nauman.hafeez920@gmail.com',      gender:'Male',   dob:'02/09/1995',     cnic:'81301-2476676-3',   join:'03/03/2025',  role:'Junior DevOps Engineer' },
  { fn:'Muhammad Taimoor', ln:'Anwar',         father:'M Anwar',                  email:'taimooranwar837@gmail.com',       gender:'Male',   dob:'10/01/2003',     cnic:'38405-2176814-1',   join:'03/03/2025',  role:'Junior DevOps Engineer' },
  { fn:'Syed Bilal',       ln:'Shah',          father:'Sartaj Ali Shah',          email:'bilal.quecko@gmail.com',          gender:'Male',   dob:'07-Sept-93',     cnic:'16101-5365602-3',   join:'11-Aug-25',   role:'Team Lead Unity' },
  { fn:'Tehreem',          ln:'Fatima',        father:'Muhammad Munir Akhtar',    email:'tehreem.fatima28@gmail.com',      gender:'Female', dob:'28-Nov-02',      cnic:'31203-1407776-8',   join:'01-Oct-25',   role:'Unity Game Developer' },
  { fn:'Fahad',            ln:'Suleman',       father:'Suleman Siddiqui',         email:'m.fahadsuleman@gmail.com',        gender:'Male',   dob:'24th Dec 1987',  cnic:'42101-2287095-9',   join:'01-Feb-22',   role:'CMO' },
  { fn:'Nafees',           ln:'Rizvi',         father:'Syed Shabbir Hussain Rizvi',email:'nafeesrizvi4@gmail.com',         gender:'Male',   dob:'05/08/2001',     cnic:'37406-6293329-3',   join:'04/11/2023',  role:'Marketing Manager' },
  { fn:'Wajahat',          ln:'Ahmed Khan',    father:'Masood Ahmad Khan',        email:'wajahatahmed708@gmail.com',       gender:'Male',   dob:'02/09/2001',     cnic:'37101-9927331-7',   join:'25-Apr-24',   role:'Business Development Executive' },
  { fn:'Ambar',            ln:'Saleem',        father:'M Saleem',                 email:'ambarsaleem1@gmail.com',          gender:'Female', dob:'02/04/1999',     cnic:'61101-5117980-4',   join:'08/01/2023',  role:'Business Development Executive' },
  { fn:'Abdul Moiz',       ln:'Shahid',        father:'Shahid Mumtaz',            email:'moizbroazan@gmail.com',           gender:'Male',   dob:'22-Feb-06',      cnic:'37202-5426853-1',   join:'08/09/2025',  role:'Graphic Designer' },
  { fn:'Burhan',           ln:'Abrar',         father:'Raja Abrar Farooq',        email:'burhanabrar41@gmail.com',         gender:'Male',   dob:'14-Jan-05',      cnic:'37405-9739664-3',   join:'17-Jun-25',   role:'Web3 Strategist' },
  { fn:'Iqra',             ln:'Jabeen',        father:'Mirza Khan',               email:'iqrajabeen919@gmail.com',         gender:'Female', dob:'1st-Sep-2000',   cnic:'37201-1178508-4',   join:'24-Sept-25',  role:'Graphic Designer' },
  { fn:'Hira',             ln:'Asif',          father:'Muhammad Asif Mian',       email:'hiraasif2028@gmail.com',          gender:'Female', dob:'9/20/2025',      cnic:'36302-2195963-8',   join:'29-Sept-25',  role:'Marketing Executive' },
  { fn:'Muhammad',         ln:'Ammar',         father:'Rao Liaquat Ali',          email:'ammarmuhammad435@gmail.com',      gender:'Male',   dob:'04-Feb-98',      cnic:'61101-6009580-7',   join:'19-Nov-25',   role:'Motion Graphic Designer' },
  { fn:'Muhammad Zeshan',  ln:'Bashir',        father:'M Bashir',                 email:'zbmalik313@gmail.com',            gender:'Male',   dob:'01/04/1995',     cnic:'31101-8785314-7',   join:'04/03/2023',  role:'Visual Designer' },
  { fn:'Sheeba',           ln:'Abbasi',        father:'Masroor Ahmed Abbasi',     email:'sheeba.abbasi@gmail.com',         gender:'Female', dob:'25/11/1982',     cnic:'61101-1978576-4',   join:'06-Feb-24',   role:'Community Officer' },
  { fn:'Khola',            ln:'Abbasi',        father:'Masroor Ahmed Abbasi',     email:'kholaabbasii@gmail.com',          gender:'Female', dob:'20/01/1984',     cnic:'61101-7914375-0',   join:'11-Sept-24',  role:'Community Officer' },
  { fn:'Nosheen',          ln:'Hussain',       father:'Muhammad Hussnain',        email:'nosheen.hussnain@gmail.com',      gender:'Female', dob:'28/05/1988',     cnic:'42101-9625615-0',   join:'08/01/2023',  role:'Community Officer' },
  { fn:'Areej',            ln:'Maqbool',       father:'Maqbool Ur Rehman',        email:'areejmaqbool1@gmail.com',         gender:'Female', dob:'25-Dec-00',      cnic:'82203-5153241-4',   join:'20-Nov-23',   role:'Community Officer' },
  { fn:'Fatima',           ln:'Ahmed',         father:'Ahmed Bashir',             email:'fa0909091@gmail.com',             gender:'Female', dob:'18/08/1999',     cnic:'34601-8229577-4',   join:'17-Apr-24',   role:'Community Officer' },
  { fn:'Muhammad Ahmed',   ln:'Naseem',        father:'Muhammad Saleem Makani',   email:'ahmedsaleems123@gmail.com',       gender:'Male',   dob:'16th june 2002', cnic:'42501-9323001-3',   join:'12-Jan-26',   role:'Backend Intern' },
  { fn:'Musawir',          ln:'Noshad',        father:'Muhammad Rasool',          email:'musavirnushad@gmail.com',         gender:'Male',   dob:'07/07/2003',     cnic:'37104-8967921-7',   join:'12-Jan-26',   role:'Backend Intern' },
  { fn:'Abdul',            ln:'Jabbar',        father:null,                       email:'abdul.jabbar@quecko.com',         gender:'Male',   dob:null,             cnic:null,                join:'18-Feb-26',   role:'Frontend Developer' },
];

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
  const db = await pool.getConnection();

  try {
    console.log('🗑  Wiping all data (keeping admins + leave_policies)...');
    await db.execute('SET FOREIGN_KEY_CHECKS = 0');

    const tables = [
      'ot_requests', 'attendance_records', 'salary_history', 'employee_salaries',
      'employee_quota_overrides', 'leave_requests', 'time_entries',
      'employee_sessions', 'employee_invites', 'employee_logs',
      'shifts', 'public_holidays', 'employees',
    ];

    for (const t of tables) {
      await db.execute(`TRUNCATE TABLE ${t}`);
      console.log(`   ✓ Cleared ${t}`);
    }

    await db.execute('SET FOREIGN_KEY_CHECKS = 1');
    console.log('');

    console.log(`👥 Importing ${employees.length} employees...`);
    let ok = 0, skipped = 0;

    for (const e of employees) {
      const name     = `${e.fn} ${e.ln}`.trim();
      const dob      = parseDate(e.dob);
      const joinDate = e.join ? parseDate(e.join) : null;

      try {
        await db.execute(
          `INSERT INTO employees
             (name, first_name, last_name, father_name, email, gender,
              date_of_birth, cnic, join_date, role, department, is_active)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'General', 0)`,
          [name, e.fn, e.ln, e.father || null, e.email, e.gender,
           dob, e.cnic || null, joinDate, e.role]
        );
        console.log(`   ✓ ${name}`);
        ok++;
      } catch (err) {
        console.error(`   ✗ ${name} — ${err.message}`);
        skipped++;
      }
    }

    console.log('');
    console.log(`✅ Done — ${ok} imported, ${skipped} skipped`);

    // Notes
    console.log('');
    console.log('📝 Notes:');
    console.log('   • Anosha Noor  — CNIC was scientific notation in Excel (stored as null, update manually)');
    console.log('   • Abdul Jabbar — no email in Excel (placeholder: abdul.jabbar@quecko.com)');
    console.log('   • Hira Asif    — DOB shows 2025 in Excel, likely a data entry error (update manually)');
    console.log('   • All employees are inactive (is_active=0). Send invites from admin panel when ready.');

  } finally {
    db.release();
    await pool.end();
  }
}

run().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
