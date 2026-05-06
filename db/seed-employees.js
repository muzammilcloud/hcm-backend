'use strict';
/**
 * One-time script: seed real employee detail data.
 * Run from project root: node db/seed-employees.js
 */
const mysql = require('mysql2/promise');

// Support both DB_USER/DB_NAME and DB_USERNAME/DB_DATABASE naming conventions
async function getPool() {
  return mysql.createPool({
    host:     process.env.DB_HOST     || 'localhost',
    port:     parseInt(process.env.DB_PORT || '3306'),
    user:     process.env.DB_USER     || process.env.DB_USERNAME || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME     || process.env.DB_DATABASE || 'queckots',
    waitForConnections: true,
    connectionLimit: 5,
  });
}

// fn=first_name, ln=last_name, fa=father_name, jd=join_date, dob=date_of_birth
const EMPLOYEES = [
  { fn:'Muhammad Alee',    ln:'Abbasi',        fa:'Masroor Abbasi',          email:'aleeabbasi021@gmail.com',         gender:'Male',   dob:'1988-05-10', cnic:'61101-4029607-7',  jd:'2020-03-01', role:'CEO' },
  { fn:'Anosha',           ln:'Noor',           fa:'Noor Muhammad',            email:'anoshanoor363@gmail.com',          gender:'Female', dob:'2000-02-14', cnic:'6.11E+12',         jd:'2025-08-28', role:'HR Specialist' },
  { fn:'Laiba',            ln:'Arshad',         fa:'Arshad Hussain',           email:'laibaarshad617@gmail.com',         gender:'Female', dob:'2002-10-20', cnic:'61101-2906892-0',  jd:'2025-10-03', role:'HR Specialist' },
  { fn:'Waleed',           ln:'Qureshi',        fa:'Muhammad Shafique',        email:'waleed.shafiq96@gmail.com',        gender:'Male',   dob:'1996-11-29', cnic:'37405-5370207-7',  jd:'2020-10-01', role:'CTO' },
  { fn:'Muhammad',         ln:'Waqas',          fa:'Muhammad Bashir',          email:'mwaqasbashir4@gmail.com',          gender:'Male',   dob:'1996-12-31', cnic:'31101-2615995-3',  jd:'2021-11-01', role:'Senior Blockchain Developer' },
  { fn:'Usama',            ln:'Saif',           fa:'Saif ur Rehman',           email:'usamasaif772@gmail.com',           gender:'Male',   dob:'1998-01-27', cnic:'37405-5319756-1',  jd:'2022-09-07', role:'Backend Developer' },
  { fn:'Saif',             ln:'Ur Rehman',      fa:'Abdul Rehman',             email:'saifurehman980@gmail.com',         gender:'Male',   dob:'1996-06-09', cnic:'82203-1525042-1',  jd:'2022-10-05', role:'Backend Developer' },
  { fn:'Faheem',           ln:'Ahmed',          fa:'Javed Akhtar Minhas',      email:'afaheem295@gmail.com',             gender:'Male',   dob:'1994-10-02', cnic:'37405-9531704-5',  jd:'2022-12-05', role:'Backend Developer' },
  { fn:'Abdul Rehman',     ln:'Sohail',         fa:'M Sohail Zulfi',           email:'adrehman11@gmail.com',             gender:'Male',   dob:'1997-11-17', cnic:'31202-2687951-3',  jd:'2022-03-14', role:'Backend Developer' },
  { fn:'Ammar',            ln:'Salahuddin',     fa:'Salahuddin Qureshi',       email:'ammarsjw@gmail.com',               gender:'Male',   dob:'1997-03-28', cnic:'41303-7993637-1',  jd:'2022-03-29', role:'Senior Blockchain Developer' },
  { fn:'Afaq',             ln:'Ahsan',          fa:'M Irfan',                  email:'afaqahsan23@gmail.com',            gender:'Male',   dob:'1998-12-11', cnic:'34601-2961300-9',  jd:'2023-03-07', role:'Blockchain Developer' },
  { fn:'Muhammad',         ln:'Shoaib',         fa:'M Shoukat',                email:'3445shoaib@gmail.com',             gender:'Male',   dob:'1997-05-03', cnic:'82203-0987357-5',  jd:'2023-07-18', role:'Backend Developer' },
  { fn:'Muhammad',         ln:'Shahid',         fa:'Saleem Pervez',            email:'contacttoshahidkhan@gmail.com',    gender:'Male',   dob:'2000-07-19', cnic:'42201-8594865-3',  jd:'2023-10-08', role:'Backend Developer' },
  { fn:'Akash',            ln:'Sabir',          fa:'Sabir Hussain',            email:'akashsabir007@gmail.com',          gender:'Male',   dob:'1995-11-19', cnic:'13101-5604008-9',  jd:'2022-02-21', role:'Senior Backend Developer' },
  { fn:'Rubab',            ln:'Babar',          fa:'Azhar Ali Babar',          email:'rubabosama998@gmail.com',          gender:'Female', dob:'1998-10-29', cnic:'35201-7144060-0',  jd:'2024-03-04', role:'Blockchain Developer' },
  { fn:'Muhammad',         ln:'Mujahid Khan',   fa:'Saleem Pervaiz Khan',      email:'immujahidkhan6@gmail.com',         gender:'Male',   dob:'1994-08-07', cnic:'42201-8499865-3',  jd:'2024-04-03', role:'Blockchain Developer' },
  { fn:'Ismat',            ln:'Batool',         fa:'Arif Hussain',             email:'ibatool.63@gmail.com',             gender:'Female', dob:'1995-12-22', cnic:'37104-7893910-6',  jd:'2024-11-19', role:'Backend Developer' },
  { fn:'Syed',             ln:'Asher',          fa:'Syed Humayun Shah',        email:'syedtirimzi@gmail.com',            gender:'Male',   dob:'1997-08-14', cnic:'13302-1778208-1',  jd:'2023-06-04', role:'Backend Developer' },
  { fn:'Muhammad',         ln:'Wasif',          fa:'Sheikh Shahid Majeed',     email:'mwasifsheikh@gmail.com',           gender:'Male',   dob:'1998-07-28', cnic:'61101-1541518-7',  jd:'2024-02-29', role:'Team Lead - Blockchain' },
  { fn:'Zulkefal',         ln:'Khan',           fa:'Jehanzeb',                 email:'zulkefal.khan705@gmail.com',       gender:'Male',   dob:'2000-12-02', cnic:'37101-7413415-5',  jd:'2024-09-02', role:'Blockchain Developer' },
  { fn:'Abdullah',         ln:'Aslam',          fa:'M Ashraf',                 email:'abdullahopl6@gmai.com',            gender:'Male',   dob:'1995-08-16', cnic:'37405-3849658-5',  jd:'2024-09-16', role:'Sr. Backend Developer' },
  { fn:'Saifullah',        ln:'Omar',           fa:'Noorshaid Ahmed',          email:'saifullahomar786@gmail.com',       gender:'Male',   dob:'2000-11-17', cnic:'16101-2836608-1',  jd:'2024-11-20', role:'Blockchain Developer' },
  { fn:'Jawad',            ln:'Khan',           fa:'Rafil Ullah Khan',         email:'jwad.khaan@gmail.com',             gender:'Male',   dob:'2004-09-17', cnic:'35201-4661120-1',  jd:'2025-04-14', role:'Backend Developer' },
  { fn:'Muhammad Salman',  ln:'Azhar',          fa:'Saeed Ahmad',              email:'salmanazhar.official@gmail.com',   gender:'Male',   dob:'1997-01-07', cnic:'36602-3342267-9',  jd:'2021-10-08', role:'Sr. Backend Developer' },
  { fn:'Shahid',           ln:'Khan Niazi',     fa:'Ghulam Abbas Khan',        email:'shahid.niazi.dev@gmail.com',       gender:'Male',   dob:'1998-05-01', cnic:'38301-8212192-1',  jd:'2025-11-05', role:'Sr. Blockchain Backend Developer' },
  { fn:'Absar',            ln:'Salahuddin',     fa:'Salahuddin Qureshi',       email:'absarsdq291@gmail.com',            gender:'Male',   dob:'2000-01-29', cnic:'41303-4187813-7',  jd:'2025-11-03', role:'Jr. Blockchain Developer' },
  { fn:'Hamza',            ln:'Khalid Khan',    fa:'Khalid Mahmood Khan',      email:'hamzakhalidkhan.13@gmail.com',     gender:'Male',   dob:'1996-11-16', cnic:'61101-2725536-1',  jd:'2024-11-21', role:'Blockchain Developer' },
  { fn:'Usman',            ln:'Aslam Malik',    fa:'M Aslam',                  email:'usman.maliknu13@gmail.com',        gender:'Male',   dob:'1993-08-04', cnic:'34104-1265917-9',  jd:'2020-06-18', role:'Team Lead Frontend' },
  { fn:'Muhammad',         ln:'Jawad',          fa:'M Anwar',                  email:'chudhryjawad@gmail.com',           gender:'Male',   dob:'1998-08-18', cnic:'37101-6407985-9',  jd:'2021-11-15', role:'Sr. Frontend Developer' },
  { fn:'Muhammad',         ln:'Awais',          fa:'M Irshad',                 email:'m.awais.genius@gmail.com',         gender:'Male',   dob:'2000-06-05', cnic:'34501-1824915-7',  jd:'2022-08-01', role:'Front-end Developer' },
  { fn:'Muhammad Abdullah',ln:'Anwar',          fa:'Anwar Ul Haq',             email:'abdullah157a157a@gmail.com',       gender:'Male',   dob:'1996-01-04', cnic:'31303-5555864-5',  jd:'2022-05-09', role:'Sr. Frontend Developer' },
  { fn:'Sardar Shahzeb',   ln:'Naseer',         fa:'Sardar Naseer M',          email:'shahzeb.naseer2@gmail.com',        gender:'Male',   dob:'1996-03-18', cnic:'13101-5336396-9',  jd:'2021-01-26', role:'Sr. Frontend Blockchain Developer' },
  { fn:'Aman',             ln:'Ullah',          fa:'Sheikh M Umer',            email:'amanullah07544@gmail.com',         gender:'Male',   dob:'1996-04-26', cnic:'37405-9544930-7',  jd:'2021-12-08', role:'Sr. Frontend Blockchain Developer' },
  { fn:'Noor',             ln:'Imad',           fa:'Imad',                     email:'noorimad274939@gmail.com',         gender:'Male',   dob:'1996-07-17', cnic:'17301-4735816-1',  jd:'2022-07-04', role:'Frontend Developer' },
  { fn:'Raza',             ln:'Awan',           fa:'Abdul Ghaffar Awan',       email:'razaawanpersonal@gmail.com',       gender:'Male',   dob:'1998-03-11', cnic:'37104-9283221-7',  jd:'2025-03-18', role:'Frontend Developer' },
  { fn:'Muhammad Yahya',   ln:'Rehman',         fa:'Khalil Ahmed',             email:'yahyarehmanlfc@gmail.com',         gender:'Male',   dob:'1994-07-03', cnic:'34201-3645725-1',  jd:'2025-04-21', role:'Frontend Developer' },
  { fn:'Muhammad',         ln:'Waleed',         fa:'M Mushtaq',                email:'m.waleedapsacian@gmail.com',       gender:'Male',   dob:'2002-01-04', cnic:'42000-5070531-3',  jd:'2024-11-18', role:'Front-end Developer' },
  { fn:'Abdul',            ln:'Basit',          fa:'M Arshad Javed',           email:'iamabdulbasit0702@gmail.com',      gender:'Male',   dob:'2002-10-21', cnic:'3330-16757629-3',  jd:'2024-11-28', role:'Front-end Developer' },
  { fn:'Muhammad Usama',   ln:'Shafique',       fa:'M Shafique',               email:'usama_shafiq97@hotmail.com',       gender:'Male',   dob:'1997-01-15', cnic:'37405-3133769-5',  jd:'2025-01-06', role:'Team Lead Frontend' },
  { fn:'Abdul',            ln:'Moiz',           fa:'Aurang Zaib',              email:'moeezabdul2004@gmail.com',         gender:'Male',   dob:'2004-07-29', cnic:'37405-1846251-7',  jd:'2022-06-07', role:'Frontend Developer' },
  { fn:'Muhammad Abdullah',ln:'Zahid',          fa:'Mirza Zahid Mahmood',      email:'aabimirza231@gmail.com',           gender:'Male',   dob:'2000-08-01', cnic:'37405-9963042-9',  jd:'2022-06-07', role:'Frontend Developer' },
  { fn:'Zahid',            ln:'Rahman',         fa:'M Idrees',                 email:'codewithxohii@gmail.com',          gender:'Male',   dob:'1999-04-01', cnic:'15101-6918488-3',  jd:'2023-03-10', role:'Frontend Developer' },
  { fn:'Usama',            ln:'Nawaz Chattha',  fa:'Afzaal Ahmad Chattha',     email:'osamachattha78@gmail.com',         gender:'Male',   dob:'1992-08-27', cnic:'38403-8387655-7',  jd:'2021-07-01', role:'Team Lead QA' },
  { fn:'Sajjad',           ln:'Baig',           fa:'Mirza Shoukat Ali Baig',   email:'sajjadbaig1227@gmail.com',         gender:'Male',   dob:'1994-09-14', cnic:'33104-5832342-9',  jd:'2022-09-12', role:'Quality Assurance Officer' },
  { fn:'Ibrahim',          ln:'Qureshi',        fa:'M Imran Qureshi',          email:'ibrahimqureshi.m17@gmail.com',     gender:'Male',   dob:'1996-08-17', cnic:'61101-9959205-9',  jd:'2023-12-04', role:'Quality Assurance Officer' },
  { fn:'Uzair',            ln:'Anwar',          fa:'Khursheed Anwar',          email:'uzairanwar0306@gmail.com',         gender:'Male',   dob:'2000-01-22', cnic:'13501-44161682-3', jd:'2024-05-20', role:'Quality Assurance Officer' },
  { fn:'Muhammad Shoaib',  ln:'Virk',           fa:'Farman Ali',               email:'shoaibvirk24@gmail.com',           gender:'Male',   dob:'1997-12-25', cnic:'34103-1630917-7',  jd:'2023-07-24', role:'Quality Assurance Officer' },
  { fn:'Fahad',            ln:'Saleem',         fa:'Saleem Ur Rehman',         email:'fahadsaleemsqaa@gmail.com',        gender:'Male',   dob:'1999-12-09', cnic:'32303-8066896-5',  jd:'2024-01-06', role:'Quality Assurance Officer' },
  { fn:'Haziq',            ln:'Ahmed Baig',     fa:'Mirza Shakoor Ahmed',      email:'haziqahmed31971@gmail.com',        gender:'Male',   dob:'2001-06-17', cnic:'37406-4192211-3',  jd:'2024-08-19', role:'Quality Assurance Officer' },
  { fn:'Uzair',            ln:'Ahsan',          fa:'Tariq Afzal',              email:'uzairahsan999@gmail.com',           gender:'Male',   dob:'2001-01-01', cnic:'37101-4400786-5',  jd:'2024-08-22', role:'Quality Assurance Officer' },
  { fn:'Muhammad',         ln:'Murtaza',        fa:'Syed Rehbar Hassan Naqvi', email:'murtaza.naqvi301@gmail.com',       gender:'Male',   dob:'2001-02-28', cnic:'17301-792830-3',   jd:'2023-09-18', role:'Quality Assurance Officer' },
  { fn:'Linta',            ln:'Binte Habib',    fa:'Maj(R) Habib Qadir',       email:'lintabintehabib2002@gmail.com',    gender:'Female', dob:'2002-01-16', cnic:'37405-1408466-6',  jd:'2025-09-15', role:'Jr. Quality Assurance Officer' },
  { fn:'Bilal',            ln:'Abdullah',       fa:'Muhammad Sajid',           email:'bilalabdullah451@gmail.com',       gender:'Male',   dob:'2002-08-19', cnic:'37405-1114974-7',  jd:'2025-12-01', role:'Jr. Quality Assurance Officer' },
  { fn:'Jamal',            ln:'Waseem',         fa:'Mazhar Hussain Waseem',    email:'jamalwaseem13@gmail.com',          gender:'Male',   dob:'1990-09-13', cnic:'61101-8065205-3',  jd:'2020-03-01', role:'Team Lead UI/UX Developer' },
  { fn:'Sardar Ahmad',     ln:'Naseem',         fa:'Sardar M Naseem',          email:'sardarahmadnaseem@gmail.com',      gender:'Male',   dob:'1986-05-11', cnic:'13101-5027562-7',  jd:'2021-12-16', role:'Sr. Frontend Developer' },
  { fn:'Usman',            ln:'Afzal',          fa:'M Afzal',                  email:'usmanheer9@gmail.com',             gender:'Male',   dob:'2000-06-22', cnic:'37405-1119542-7',  jd:'2022-05-16', role:'Sr. UI/UX Developer' },
  { fn:'Hamza',            ln:'Iftikhar',       fa:'Iftikhar Ahmed',           email:'hamzach625@gmail.com',             gender:'Male',   dob:'1999-09-08', cnic:'31303-3047956-9',  jd:'2022-05-09', role:'Sr. UI/UX Developer' },
  { fn:'Wardah',           ln:'Rehman',         fa:'Abdur Rehman',             email:'wardahrehman703@gmail.com',        gender:'Female', dob:'2000-08-27', cnic:'37201-3249761-2',  jd:'2024-03-01', role:'Frontend Developer' },
  { fn:'Hamza',            ln:'Ellahi',         fa:'Asif Elahi',               email:'hamzaval2000@gmail.com',           gender:'Male',   dob:'2005-01-18', cnic:'61101-6388641-9',  jd:null,         role:'Frontend Developer' },
  { fn:'Muhammad',         ln:'Hammad',         fa:'M Anwar',                  email:'hammadanwar6520@gmail.com',        gender:'Male',   dob:'2004-09-20', cnic:'32203-6972138-3',  jd:'2024-12-01', role:'Frontend Developer' },
  { fn:'Sharjeel',         ln:'Awan',           fa:'Ghulam Haider Awan',       email:'sharjeelawan88@gmail.com',         gender:'Male',   dob:'1988-07-20', cnic:'36302-9321977-5',  jd:'2021-06-07', role:'Chief Product Officer' },
  { fn:'Umar Ali',         ln:'Butt',           fa:'Ali Raza Butt',            email:'ub1894497@gmail.com',              gender:'Male',   dob:'2005-01-17', cnic:'61101-1601510-7',  jd:'2021-09-20', role:'Senior Product Designer' },
  { fn:'Khawar',           ln:'Ali Ramzan',     fa:'M Ramzan',                 email:'khawaraliramzan@gmail.com',        gender:'Male',   dob:'1994-12-16', cnic:'61101-5606055-7',  jd:'2020-04-01', role:'Senior Product Designer' },
  { fn:'Asad',             ln:'Ullah 3D',       fa:'Shabbir Hussain',          email:'asadbutt_1@hotmail.com',           gender:'Male',   dob:'1999-11-13', cnic:'34202-2230421-3',  jd:'2022-04-05', role:'Associate Product Designer' },
  { fn:'Zahir',            ln:'Bakhash',        fa:'Raziq Bakhash',            email:'zahirbakhash5@gmail.com',          gender:'Male',   dob:'2005-07-08', cnic:'61101-2713645-5',  jd:'2023-09-07', role:'Associate Product Designer' },
  { fn:'Abu Bakkar',       ln:'Khan',           fa:'M Dayar Khan',             email:'khan.shani99@gmail.com',           gender:'Male',   dob:'1998-08-01', cnic:'61101-6053564-9',  jd:'2022-04-25', role:'Senior Product Designer' },
  { fn:'Awais',            ln:'Raza',           fa:'Muhammad Sarfraz',         email:'awaissarfa@gmail.com',             gender:'Male',   dob:'2001-10-18', cnic:'36502-8112767-3',  jd:'2025-10-06', role:'Associate Product Designer' },
  { fn:'Muhammad Zia',     ln:'Ul Rehman',      fa:'M Zaman',                  email:'zeekhan7872@gmail.com',            gender:'Male',   dob:'1994-12-28', cnic:'32304-6071017-9',  jd:'2021-11-01', role:'Team Lead Mobile App' },
  { fn:'Adnan',            ln:'Saleem',         fa:'Mohammad Saleem',          email:'adnankhan3937@gmail.com',          gender:'Male',   dob:'1997-03-12', cnic:'82101-9901670-9',  jd:'2022-04-25', role:'Senior Mobile App Developer' },
  { fn:'Muhammad',         ln:'Asjad',          fa:'Wajid Mehmood',            email:'mughalaasjad577@gmail.com',        gender:'Male',   dob:'1998-12-01', cnic:'37402-6827987-1',  jd:'2023-08-16', role:'Mobile App Developer' },
  { fn:'Abdul',            ln:'Basit',          fa:'Shaukat Ali Awan',         email:'abdulrocker4@gmail.com',           gender:'Male',   dob:'2002-07-26', cnic:'90406-0183513-1',  jd:'2025-06-16', role:'Jr. Mobile App Developer' },
  { fn:'Farhan',           ln:'Razzaq',         fa:'Abdul Razzaq',             email:'farhanrazzaq57@gmail.com',         gender:'Male',   dob:'1997-08-04', cnic:'34602-5703633-3',  jd:'2023-08-15', role:'Senior Mobile App Developer' },
  { fn:'Ateeq',            ln:'Ur Rehman',      fa:'Abdul Shakoor',            email:'ateeq4112@gmail.com',              gender:'Male',   dob:'1997-01-02', cnic:'71301-0335180-5',  jd:'2025-10-28', role:'Senior Mobile App Developer' },
  { fn:'Muhammad',         ln:'Shehryar',       fa:'Allah Ditta',              email:'shehryarmuhammad97@gmail.com',     gender:'Male',   dob:'1997-12-25', cnic:'61101-2258406-7',  jd:'2025-10-15', role:'Senior Mobile App Developer' },
  { fn:'Hamid',            ln:'Shehzad',        fa:'Awal Khan',                email:'softwaresdeveloper143@gmail.com',  gender:'Male',   dob:'1995-01-16', cnic:'17201-6651115-1',  jd:'2025-10-13', role:'Senior Mobile App Developer' },
  { fn:'Muhammad',         ln:'Muzammil',       fa:'Dil Nawaz Khan',           email:'mmuzammil.tech@gmail.com',         gender:'Male',   dob:'1998-12-22', cnic:'42401-9732865-1',  jd:'2025-10-20', role:'Team Lead DevOps' },
  { fn:'Muhammad Nauman',  ln:'Hafeez',         fa:'Hafeez Ur Rehman',         email:'nauman.hafeez920@gmail.com',       gender:'Male',   dob:'1995-09-02', cnic:'81301-2476676-3',  jd:'2025-03-03', role:'Junior DevOps Engineer' },
  { fn:'Muhammad Taimoor', ln:'Anwar',          fa:'M Anwar',                  email:'taimooranwar837@gmail.com',        gender:'Male',   dob:'2003-01-10', cnic:'38405-2176814-1',  jd:'2025-03-03', role:'Junior DevOps Engineer' },
  { fn:'Syed Bilal',       ln:'Shah',           fa:'Sartaj Ali Shah',          email:'bilal.quecko@gmail.com',           gender:'Male',   dob:'1993-09-07', cnic:'16101-5365602-3',  jd:'2025-08-11', role:'Team Lead Unity' },
  { fn:'Tehreem',          ln:'Fatima',         fa:'Muhammad Munir Akhtar',    email:'tehreem.fatima28@gmail.com',       gender:'Female', dob:'2002-11-28', cnic:'31203-1407776-8',  jd:'2025-10-01', role:'Unity Game Developer' },
  { fn:'Fahad',            ln:'Suleman',        fa:'Suleman Siddiqui',         email:'m.fahadsuleman@gmail.com',         gender:'Male',   dob:'1987-12-24', cnic:'42101-2287095-9',  jd:'2022-02-01', role:'CMO' },
  { fn:'Nafees',           ln:'Rizvi',          fa:'Syed Shabbir Hussain Rizvi',email:'nafeesrizvi4@gmail.com',          gender:'Male',   dob:'2001-08-05', cnic:'37406-6293329-3',  jd:'2023-11-04', role:'Marketing Manager' },
  { fn:'Wajahat',          ln:'Ahmed Khan',     fa:'Masood Ahmad Khan',        email:'wajahatahmed708@gmail.com',        gender:'Male',   dob:'2001-09-02', cnic:'37101-9927331-7',  jd:'2024-04-25', role:'Business Development Executive' },
  { fn:'Ambar',            ln:'Saleem',         fa:'M Saleem',                 email:'ambarsaleem1@gmail.com',           gender:'Female', dob:'1999-04-02', cnic:'61101-5117980-4',  jd:'2023-01-08', role:'Business Development Executive' },
  { fn:'Abdul Moiz',       ln:'Shahid',         fa:'Shahid Mumtaz',            email:'moizbroazan@gmail.com',            gender:'Male',   dob:'2006-02-22', cnic:'37202-5426853-1',  jd:'2025-09-08', role:'Graphic Designer' },
  { fn:'Burhan',           ln:'Abrar',          fa:'Raja Abrar Farooq',        email:'burhanabrar41@gmail.com',          gender:'Male',   dob:'2005-01-14', cnic:'37405-9739664-3',  jd:'2025-06-17', role:'Web3 Strategist' },
  { fn:'Iqra',             ln:'Jabeen',         fa:'Mirza Khan',               email:'iqrajabeen919@gmail.com',          gender:'Female', dob:'2000-09-01', cnic:'37201-1178508-4',  jd:'2025-09-24', role:'Graphic Designer' },
  { fn:'Hira',             ln:'Asif',           fa:'Muhammad Asif Mian',       email:'hiraasif2028@gmail.com',           gender:'Female', dob:'2025-09-20', cnic:'36302-2195963-8',  jd:'2025-09-29', role:'Marketing Executive' }, // NOTE: DOB looks like a data-entry error (future date)
  { fn:'Muhammad',         ln:'Ammar',          fa:'Rao Liaquat Ali',          email:'ammarmuhammad435@gmail.com',       gender:'Male',   dob:'1998-02-04', cnic:'61101-6009580-7',  jd:'2025-11-19', role:'Motion Graphic Designer' },
  { fn:'Muhammad Zeshan',  ln:'Bashir',         fa:'M Bashir',                 email:'zbmalik313@gmail.com',             gender:'Male',   dob:'1995-04-01', cnic:'31101-8785314-7',  jd:'2023-03-04', role:'Visual Designer' },
  { fn:'Sheeba',           ln:'Abbasi',         fa:'Masroor Ahmed Abbasi',     email:'sheeba.abbasi@gmail.com',          gender:'Female', dob:'1982-11-25', cnic:'61101-1978576-4',  jd:'2024-02-06', role:'Community Officer' },
  { fn:'Khola',            ln:'Abbasi',         fa:'Masroor Ahmed Abbasi',     email:'kholaabbasii@gmail.com',           gender:'Female', dob:'1984-01-20', cnic:'61101-7914375-0',  jd:'2024-09-11', role:'Community Officer' },
  { fn:'Nosheen',          ln:'Hussain',        fa:'Muhammad Hussnain',        email:'nosheen.hussnain@gmail.com',       gender:'Female', dob:'1988-05-28', cnic:'42101-9625615-0',  jd:'2023-01-08', role:'Community Officer' },
  { fn:'Areej',            ln:'Maqbool',        fa:'Maqbool Ur Rehman',        email:'areejmaqbool1@gmail.com',          gender:'Female', dob:'2000-12-25', cnic:'82203-5153241-4',  jd:'2023-11-20', role:'Community Officer' },
  { fn:'Fatima',           ln:'Ahmed',          fa:'Ahmed Bashir',             email:'fa0909091@gmail.com',              gender:'Female', dob:'1999-08-18', cnic:'34601-8229577-4',  jd:'2024-04-17', role:'Community Officer' },
  { fn:'Muhammad Ahmed',   ln:'Naseem',         fa:'Muhammad Saleem Makani',   email:'ahmedsaleems123@gmail.com',        gender:'Male',   dob:'2002-06-16', cnic:'42501-9323001-3',  jd:'2026-01-12', role:'Backend Intern' },
  { fn:'Musawir',          ln:'Noshad',         fa:'Muhammad Rasool',          email:'musavirnushad@gmail.com',          gender:'Male',   dob:'2003-07-07', cnic:'37104-8967921-7',  jd:'2026-01-12', role:'Backend Intern' },
  // Abdul Jabbar — no email in source data, cannot match; add manually via admin panel
];

async function run() {
  const pool = await getPool();
  console.log(`Connecting: ${process.env.DB_USER || process.env.DB_USERNAME || 'root'}@${process.env.DB_HOST || 'localhost'}/${process.env.DB_NAME || process.env.DB_DATABASE || 'queckots'}\n`);
  let updated = 0, inserted = 0;

  for (const e of EMPLOYEES) {
    const name = `${e.fn} ${e.ln}`;
    const vals = [name, e.fn, e.ln, e.fa, e.gender, e.dob || null, e.cnic || null, e.jd || null, e.role];

    // 1. Try to update existing employee (match by email, case-insensitive)
    const [upd] = await pool.execute(
      `UPDATE employees
       SET name=?, first_name=?, last_name=?, father_name=?, gender=?,
           date_of_birth=?, cnic=?, join_date=?, role=?
       WHERE LOWER(email) = LOWER(?)`,
      [...vals, e.email]
    );

    if (upd.affectedRows > 0) {
      updated++;
      console.log(`✓ updated  ${name.padEnd(36)} ${e.email}`);
    } else {
      // 2. Not in DB yet — insert as new employee (pending, no password)
      await pool.execute(
        `INSERT INTO employees
           (name, email, role, department, is_active,
            first_name, last_name, father_name, gender,
            date_of_birth, cnic, join_date)
         VALUES (?, ?, ?, 'General', 0, ?, ?, ?, ?, ?, ?, ?)`,
        [name, e.email, e.role, e.fn, e.ln, e.fa, e.gender, e.dob || null, e.cnic || null, e.jd || null]
      );
      inserted++;
      console.log(`+ inserted ${name.padEnd(36)} ${e.email}`);
    }
  }

  console.log(`\n──────────────────────────────────────────────`);
  console.log(`✓ Updated : ${updated}`);
  console.log(`+ Inserted: ${inserted}`);
  console.log(`\nDone. New employees are pending — use admin panel to send invites.`);
  process.exit(0);
}

run().catch(err => { console.error(err); process.exit(1); });
